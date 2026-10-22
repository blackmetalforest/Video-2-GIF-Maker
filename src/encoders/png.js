/**
 * A small PNG encoder, plus the chunk plumbing shared with the APNG muxer.
 *
 * Why hand-roll this when browsers have one built in? Because Chrome's canvas
 * PNG encoder is startlingly slow: measured at about a second for a single
 * 160x160 frame, against 39 ms for the same frame as WebP. Deflating it here
 * through fflate takes milliseconds.
 */

import { zlibSync } from '../../vendor/fflate.module.js';

const SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function readU32(bytes, at) {
  return ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;
}

export function writeU32(bytes, at, value) {
  bytes[at] = (value >>> 24) & 0xff;
  bytes[at + 1] = (value >>> 16) & 0xff;
  bytes[at + 2] = (value >>> 8) & 0xff;
  bytes[at + 3] = value & 0xff;
}

/** Serialise one PNG chunk: length, type, payload, CRC over type+payload. */
export function chunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  writeU32(out, 0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  writeU32(out, 8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** Split a PNG into its chunks. */
export function readChunks(bytes) {
  for (let i = 0; i < 8; i++) {
    if (bytes[i] !== SIGNATURE[i]) throw new Error('Not a PNG (bad signature)');
  }
  const chunks = [];
  let at = 8;
  while (at + 8 <= bytes.length) {
    const length = readU32(bytes, at);
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    chunks.push({ type, data: bytes.subarray(at + 8, at + 8 + length) });
    at += 12 + length;
    if (type === 'IEND') break;
  }
  return chunks;
}

/** PNG's Paeth predictor — picks whichever neighbour best predicts the pixel. */
function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/**
 * Encode RGBA pixels as a PNG.
 *
 * Every row is Paeth-filtered (type 4). Filtering costs a little CPU but pays
 * for itself many times over on smooth 3D renders, where neighbouring pixels
 * are highly correlated — unfiltered rows compress far worse.
 *
 * @param {ImageData|{data:Uint8ClampedArray,width:number,height:number}} image
 * @param {{level?: number}} opts fflate deflate level, 0-9
 * @returns {Uint8Array}
 */
export function encodePng(image, { level = 4 } = {}) {
  const { width, height } = image;
  const src = image.data;
  const stride = width * 4;

  // Filtered scanlines: one filter-type byte per row, then the row itself.
  const raw = new Uint8Array((stride + 1) * height);
  let out = 0;
  for (let y = 0; y < height; y++) {
    const row = y * stride;
    const prev = row - stride;
    raw[out++] = 4;                                  // filter: Paeth
    for (let x = 0; x < stride; x++) {
      const left = x >= 4 ? src[row + x - 4] : 0;
      const up = y > 0 ? src[prev + x] : 0;
      const upLeft = y > 0 && x >= 4 ? src[prev + x - 4] : 0;
      raw[out++] = (src[row + x] - paeth(left, up, upLeft)) & 0xff;
    }
  }

  const ihdr = new Uint8Array(13);
  writeU32(ihdr, 0, width);
  writeU32(ihdr, 4, height);
  ihdr[8] = 8;        // bit depth
  ihdr[9] = 6;        // colour type: RGBA
  ihdr[10] = 0;       // deflate
  ihdr[11] = 0;       // adaptive filtering
  ihdr[12] = 0;       // no interlace

  // IDAT carries a zlib stream (not bare deflate).
  const idat = zlibSync(raw, { level });

  const parts = [SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', new Uint8Array(0))];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const file = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { file.set(p, at); at += p.length; }
  return file;
}
