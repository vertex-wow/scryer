const BLP2_MAGIC: u32 = 0x32504c42; // 'BLP2' LE
const HEADER_SIZE: usize = 148;

/// Decode a BLP2 buffer to raw RGBA bytes + (width, height).
/// Supports encoding=2 (DXT1/DXT3/DXT5) and encoding=3 (rawBGRA).
/// Encoding=1 (palette) returns an error; the caller falls back to js-blp.
pub fn decode(buf: &[u8]) -> Result<(Vec<u8>, u32, u32), String> {
    if buf.len() < HEADER_SIZE {
        return Err(format!("BLP2 buffer too small: {} bytes", buf.len()));
    }

    let magic = u32::from_le_bytes(buf[0..4].try_into().unwrap());
    if magic != BLP2_MAGIC {
        return Err("Not a BLP2 file".into());
    }
    if buf[4] != 1 {
        return Err(format!("Unsupported BLP type: {}", buf[4]));
    }

    let encoding = buf[8];
    let alpha_depth = buf[9];
    let alpha_encoding = buf[10];
    let width = u32::from_le_bytes(buf[12..16].try_into().unwrap());
    let height = u32::from_le_bytes(buf[16..20].try_into().unwrap());
    // mip 0 offset at byte 20, size at byte 84 (= 20 + 16×4)
    let map_offset = u32::from_le_bytes(buf[20..24].try_into().unwrap()) as usize;
    let map_size = u32::from_le_bytes(buf[84..88].try_into().unwrap()) as usize;

    if map_offset + map_size > buf.len() {
        return Err(format!(
            "BLP2 mip data out of bounds: offset={} size={} buflen={}",
            map_offset,
            map_size,
            buf.len()
        ));
    }
    let raw = &buf[map_offset..map_offset + map_size];
    let pixel_count = (width * height) as usize;

    match encoding {
        3 => decode_raw_bgra(raw, pixel_count),
        2 => {
            let is_dxt1 = alpha_depth <= 1;
            let is_dxt5 = !is_dxt1 && alpha_encoding == 7;
            decode_dxt(raw, width, height, pixel_count, is_dxt1, is_dxt5)
        }
        _ => Err(format!("Unsupported BLP encoding: {encoding}")),
    }
    .map(|rgba| (rgba, width, height))
}

fn decode_raw_bgra(raw: &[u8], pixel_count: usize) -> Result<Vec<u8>, String> {
    if raw.len() < pixel_count * 4 {
        return Err(format!(
            "rawBGRA underflow: expected {} bytes, got {}",
            pixel_count * 4,
            raw.len()
        ));
    }
    let mut rgba = Vec::with_capacity(pixel_count * 4);
    for chunk in raw[..pixel_count * 4].chunks_exact(4) {
        rgba.push(chunk[2]); // R = B
        rgba.push(chunk[1]); // G
        rgba.push(chunk[0]); // B = R
        rgba.push(chunk[3]); // A
    }
    Ok(rgba)
}

fn decode_dxt(
    src: &[u8],
    width: u32,
    height: u32,
    pixel_count: usize,
    is_dxt1: bool,
    is_dxt5: bool,
) -> Result<Vec<u8>, String> {
    let block_bytes: usize = if is_dxt1 { 8 } else { 16 };
    let mut rgba = vec![0u8; pixel_count * 4];

    // Reusable per-block scratch — no heap allocs in the inner loop
    let mut colors = [0u8; 16]; // 4 RGBA color palette entries
    let mut alpha_table = [0u8; 8]; // DXT5: 8 interpolated alpha values
    let mut alpha_idx = [0u8; 16]; // DXT5: 16 decoded 3-bit alpha indices

    let mut pos = 0usize;

    let bh = (height as usize + 3) / 4;
    let bw = (width as usize + 3) / 4;
    let total_blocks = bh * bw;

    if src.len() < total_blocks * block_bytes {
        return Err(format!(
            "DXT src underflow: expected {} bytes, got {}",
            total_blocks * block_bytes,
            src.len()
        ));
    }

    for by in (0..height).step_by(4) {
        for bx in (0..width).step_by(4) {
            let color_off = if is_dxt1 { pos } else { pos + 8 };

            let c0 = u16::from_le_bytes([src[color_off], src[color_off + 1]]);
            let c1 = u16::from_le_bytes([src[color_off + 2], src[color_off + 3]]);

            let r0 = ((c0 >> 11) & 0x1f) as u32 * 255 / 31;
            let g0 = ((c0 >> 5) & 0x3f) as u32 * 255 / 63;
            let b0 = (c0 & 0x1f) as u32 * 255 / 31;
            let r1 = ((c1 >> 11) & 0x1f) as u32 * 255 / 31;
            let g1 = ((c1 >> 5) & 0x3f) as u32 * 255 / 63;
            let b1 = (c1 & 0x1f) as u32 * 255 / 31;

            colors[0] = r0 as u8;
            colors[1] = g0 as u8;
            colors[2] = b0 as u8;
            colors[3] = 255;
            colors[4] = r1 as u8;
            colors[5] = g1 as u8;
            colors[6] = b1 as u8;
            colors[7] = 255;

            if is_dxt1 && c0 <= c1 {
                colors[8] = ((r0 + r1) / 2) as u8;
                colors[9] = ((g0 + g1) / 2) as u8;
                colors[10] = ((b0 + b1) / 2) as u8;
                colors[11] = 255;
                colors[12] = 0;
                colors[13] = 0;
                colors[14] = 0;
                colors[15] = 0;
            } else {
                colors[8] = ((2 * r0 + r1) / 3) as u8;
                colors[9] = ((2 * g0 + g1) / 3) as u8;
                colors[10] = ((2 * b0 + b1) / 3) as u8;
                colors[11] = 255;
                colors[12] = ((r0 + 2 * r1) / 3) as u8;
                colors[13] = ((g0 + 2 * g1) / 3) as u8;
                colors[14] = ((b0 + 2 * b1) / 3) as u8;
                colors[15] = 255;
            }

            let color_indices = u32::from_le_bytes([
                src[color_off + 4],
                src[color_off + 5],
                src[color_off + 6],
                src[color_off + 7],
            ]);

            if is_dxt5 {
                let a0 = src[pos];
                let a1 = src[pos + 1];
                alpha_table[0] = a0;
                alpha_table[1] = a1;
                if a0 > a1 {
                    for i in 1usize..7 {
                        alpha_table[i + 1] =
                            (((7 - i) as u32 * a0 as u32 + i as u32 * a1 as u32) / 7) as u8;
                    }
                } else {
                    for i in 1usize..5 {
                        alpha_table[i + 1] =
                            (((5 - i) as u32 * a0 as u32 + i as u32 * a1 as u32) / 5) as u8;
                    }
                    alpha_table[6] = 0;
                    alpha_table[7] = 255;
                }
                let lo = src[pos + 2] as u32
                    | ((src[pos + 3] as u32) << 8)
                    | ((src[pos + 4] as u32) << 16);
                let hi = src[pos + 5] as u32
                    | ((src[pos + 6] as u32) << 8)
                    | ((src[pos + 7] as u32) << 16);
                for i in 0usize..8 {
                    alpha_idx[i] = ((lo >> (i * 3)) & 7) as u8;
                    alpha_idx[i + 8] = ((hi >> (i * 3)) & 7) as u8;
                }
            }

            for py in 0u32..4 {
                let sy = by + py;
                if sy >= height {
                    continue;
                }
                let row_off = ((sy * width + bx) * 4) as usize;

                for px in 0u32..4 {
                    let sx = bx + px;
                    if sx >= width {
                        continue;
                    }

                    let pi = (py * 4 + px) as usize;
                    let ci = ((color_indices >> (pi * 2)) & 3) as usize;
                    let dst = row_off + px as usize * 4;

                    rgba[dst] = colors[ci * 4];
                    rgba[dst + 1] = colors[ci * 4 + 1];
                    rgba[dst + 2] = colors[ci * 4 + 2];
                    rgba[dst + 3] = colors[ci * 4 + 3];

                    if is_dxt5 {
                        rgba[dst + 3] = alpha_table[alpha_idx[pi] as usize];
                    } else if !is_dxt1 {
                        // DXT3: 4-bit explicit alpha, two pixels per byte
                        let abyte = src[pos + (pi >> 1)];
                        rgba[dst + 3] = if pi % 2 == 0 {
                            (abyte & 0xf) * 17
                        } else {
                            ((abyte >> 4) & 0xf) * 17
                        };
                    }
                }
            }

            pos += block_bytes;
        }
    }

    Ok(rgba)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_blp2_header(encoding: u8, alpha_depth: u8, alpha_enc: u8, w: u32, h: u32) -> Vec<u8> {
        let mut hdr = vec![0u8; 148];
        hdr[0..4].copy_from_slice(&BLP2_MAGIC.to_le_bytes());
        hdr[4] = 1; // type
        hdr[8] = encoding;
        hdr[9] = alpha_depth;
        hdr[10] = alpha_enc;
        hdr[12..16].copy_from_slice(&w.to_le_bytes());
        hdr[16..20].copy_from_slice(&h.to_le_bytes());
        // mip 0 offset = HEADER_SIZE
        hdr[20..24].copy_from_slice(&(HEADER_SIZE as u32).to_le_bytes());
        hdr
    }

    #[test]
    fn rejects_non_blp2() {
        let mut buf = vec![0u8; 148];
        buf[0..4].copy_from_slice(b"PNG\x0d");
        assert!(decode(&buf).is_err());
    }

    #[test]
    fn rejects_unsupported_type() {
        let mut buf = make_blp2_header(2, 0, 0, 4, 4);
        buf[4] = 2; // type != 1
        buf.extend_from_slice(&[0u8; 32]);
        let result = decode(&buf);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Unsupported BLP type"));
    }

    #[test]
    fn rejects_palette_encoding() {
        let mut buf = make_blp2_header(1, 0, 0, 4, 4);
        buf.extend_from_slice(&[0u8; 256 * 4 + 16]); // palette + mip data
        // size = 16 pixels * 1 byte index each = 16
        buf[84..88].copy_from_slice(&16u32.to_le_bytes());
        let result = decode(&buf);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Unsupported BLP encoding: 1"));
    }

    #[test]
    fn decodes_raw_bgra_1x1() {
        let mut buf = make_blp2_header(3, 8, 0, 1, 1);
        let pixel = [0x10u8, 0x20, 0x30, 0xFF]; // BGRA
        buf[84..88].copy_from_slice(&4u32.to_le_bytes()); // mapSize = 4
        buf.extend_from_slice(&pixel);
        let (rgba, w, h) = decode(&buf).unwrap();
        assert_eq!(w, 1);
        assert_eq!(h, 1);
        assert_eq!(rgba, vec![0x30, 0x20, 0x10, 0xFF]); // RGBA
    }

    #[test]
    fn decodes_dxt1_4x4_opaque() {
        // Minimal DXT1 block: c0 > c1 → opaque 4-color mode.
        // c0 = RGB565(31,0,0) = red = 0xF800
        // c1 = RGB565(0,0,31) = blue = 0x001F
        // All 16 pixels use color index 0 (c0 = red).
        let c0: u16 = 0xF800;
        let c1: u16 = 0x001F;
        let mut block = vec![0u8; 8];
        block[0..2].copy_from_slice(&c0.to_le_bytes());
        block[2..4].copy_from_slice(&c1.to_le_bytes());
        // indices = 0 for all 16 pixels (already zero)

        let mut buf = make_blp2_header(2, 0, 0, 4, 4);
        buf[84..88].copy_from_slice(&8u32.to_le_bytes());
        buf.extend_from_slice(&block);

        let (rgba, w, h) = decode(&buf).unwrap();
        assert_eq!(w, 4);
        assert_eq!(h, 4);
        assert_eq!(rgba.len(), 64);
        // First pixel should be red (r0 = 255, g0 = 0, b0 = 0, a = 255)
        let r = (31u32 * 255 / 31) as u8; // = 255
        assert_eq!(&rgba[0..4], &[r, 0, 0, 255]);
    }
}
