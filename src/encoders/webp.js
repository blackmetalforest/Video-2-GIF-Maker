/**
 * Animated WebP muxing, in pure JavaScript.
 *
 * Browsers can already encode a *still* WebP (canvas.toBlob('image/webp')),
 * and they do it natively and fast. What they cannot do is join stills into an
 * animation. That turns out to be pure container work — no encoder, no WASM —
 * so this module assembles the RIFF chunks by hand:
 *
 *   RIFF....WEBP
 *     VP8X   canvas size + feature flags (animation, alpha)
 *     ANIM   background colour + loop count
 *     ANMF   per frame: position, size, duration, then that frame's own
 *            bitstream chunks (ALPH? + VP8, or VP8L) lifted from the still
 *
 * Doing it this way keeps the whole pipeline dependency-free and avoids
 * SharedArrayBuffer entirely, which matters because GitHub Pages cannot send
 * the COOP/COEP headers threaded WASM would need.
 *
 * Reference: https://developers.google.com/speed/webp/docs/riff_container
 */

const FOURCC = (s) => [s.charCodeAt(0), s.charCodeAt(1), s.charCodeAt(2), s.charCodeAt(3)];

// VP8X feature flags. Bit order runs from the MSB: Rsv Rsv ICC Alpha EXIF XMP Anim Rsv
const FLAG_ALPHA = 0x10;
const FLAG_ANIMATION = 0x02;

/** Read a 32-bit little-endian integer. */
function readU32(bytes, offset) {
  return (bytes[offset] | (bytes[offset + 1] << 8) |
          (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

function writeU32(bytes, offset, value) {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = (value >>> 16) & 0xff;
  bytes[offset + 3] = (value >>> 24) & 0xff;
}

/** WebP stores several fields as 24-bit little-endian. */
function writeU24(bytes, offset, value) {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = (value >>> 16) & 0xff;
}

/**
 * Split a still WebP file into its RIFF chunks.
 * Returns a map of FourCC -> {start, size} describing the payload span.
 */
export function readChunks(file) {
  const bytes = file instanceof Uint8Array ? file : new Uint8Array(file);
  const tag = String.fromCharCode(...bytes.subarray(0, 4));
  const form = String.fromCharCode(...bytes.subarray(8, 12));
  if (tag !== 'RIFF' || form !== 'WEBP') {
    throw new Error('Not a WebP file (missing RIFF/WEBP signature)');
  }
  const chunks = {};
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const fourcc = String.fromCharCode(...bytes.subarray(offset, offset + 4));
    const size = readU32(bytes, offset + 4);
    chunks[fourcc] = { start: offset + 8, size };
    // Chunks are padded to an even length; the pad byte is not counted in size.
    offset += 8 + size + (size & 1);
  }
  return { bytes, chunks };
}

/**
 * Pull the pieces of a still WebP that belong inside an ANMF frame.
 *
 * A still can arrive in three shapes: bare lossy (VP8), bare lossless (VP8L,
 * which carries its own alpha), or extended (VP8X + optional ALPH + VP8).
 * Only the bitstream chunks travel into the animation — the still's own
 * container is discarded.
 */
function frameBitstream(still) {
  const { bytes, chunks } = readChunks(still);
  const parts = [];
  let hasAlpha = false;

  if (chunks.ALPH) {
    parts.push({ fourcc: 'ALPH', data: bytes.subarray(chunks.ALPH.start, chunks.ALPH.start + chunks.ALPH.size) });
    hasAlpha = true;
  }
  if (chunks.VP8L) {
    const data = bytes.subarray(chunks.VP8L.start, chunks.VP8L.start + chunks.VP8L.size);
    // VP8L header bit 28 of the first 5 bytes marks "has alpha".
    if (data.length > 4 && (data[4] & 0x10) !== 0) hasAlpha = true;
    parts.push({ fourcc: 'VP8L', data });
  } else if (chunks.VP8 !== undefined) {
    parts.push({ fourcc: 'VP8 ', data: bytes.subarray(chunks.VP8.start, chunks.VP8.start + chunks.VP8.size) });
  } else if (chunks['VP8 ']) {
    parts.push({ fourcc: 'VP8 ', data: bytes.subarray(chunks['VP8 '].start, chunks['VP8 '].start + chunks['VP8 '].size) });
  } else if (!chunks.VP8L) {
    throw new Error('WebP frame has no VP8/VP8L bitstream');
  }
  if (chunks.VP8X) {
    const flags = bytes[chunks.VP8X.start];
    if (flags & FLAG_ALPHA) hasAlpha = true;
  }
  return { parts, hasAlpha };
}

/** Serialise one RIFF chunk (FourCC + size + payload + pad). */
function chunk(fourcc, payload) {
  const padded = payload.length + (payload.length & 1);
  const out = new Uint8Array(8 + padded);
  out.set(FOURCC(fourcc), 0);
  writeU32(out, 4, payload.length);
  out.set(payload, 8);
  return out;
}

/**
 * Join still WebP frames into one looping animated WebP.
 *
 * @param {Array<{data: Uint8Array, duration: number}>} frames encoded stills
 * @param {{width: number, height: number, loop?: number, background?: number}} opts
 * @returns {Uint8Array} the animated WebP file
 */
export function muxAnimation(frames, opts) {
  if (!frames || frames.length === 0) throw new Error('No frames to mux');
  const { width, height, loop = 0, background = 0x00000000 } = opts;
  if (!width || !height) throw new Error('muxAnimation needs canvas width and height');

  let anyAlpha = false;
  const anmfChunks = frames.map(({ data, duration }) => {
    const { parts, hasAlpha } = frameBitstream(data);
    if (hasAlpha) anyAlpha = true;

    const bitstream = parts.map((p) => chunk(p.fourcc, p.data));
    const bitstreamLength = bitstream.reduce((n, c) => n + c.length, 0);

    // 16-byte ANMF header, then the frame's bitstream chunks.
    const payload = new Uint8Array(16 + bitstreamLength);
    writeU24(payload, 0, 0);                       // frame X (in 2px units)
    writeU24(payload, 3, 0);                       // frame Y
    writeU24(payload, 6, width - 1);
    writeU24(payload, 9, height - 1);
    writeU24(payload, 12, Math.max(0, Math.round(duration)));
    // Full-canvas frames: no blending with the previous frame, no disposal.
    // Blending would let a transparent pixel reveal the frame underneath.
    payload[15] = 0x02;
    let at = 16;
    for (const c of bitstream) { payload.set(c, at); at += c.length; }
    return chunk('ANMF', payload);
  });

  const vp8x = new Uint8Array(10);
  vp8x[0] = FLAG_ANIMATION | (anyAlpha ? FLAG_ALPHA : 0);
  writeU24(vp8x, 4, width - 1);
  writeU24(vp8x, 7, height - 1);

  const anim = new Uint8Array(6);
  writeU32(anim, 0, background >>> 0);
  anim[4] = loop & 0xff;
  anim[5] = (loop >>> 8) & 0xff;

  const body = [chunk('VP8X', vp8x), chunk('ANIM', anim), ...anmfChunks];
  const bodyLength = body.reduce((n, c) => n + c.length, 0);

  const file = new Uint8Array(12 + bodyLength);
  file.set(FOURCC('RIFF'), 0);
  writeU32(file, 4, 4 + bodyLength);              // everything after this field
  file.set(FOURCC('WEBP'), 8);
  let at = 12;
  for (const c of body) { file.set(c, at); at += c.length; }
  return file;
}

/**
 * Encode one RGBA frame to a still WebP using the browser's native encoder.
 * `quality` is 0..1. Lossless keeps crisp edges but produces much larger files.
 */
export async function encodeStill(imageData, { quality = 0.9, lossless = false } = {}) {
  const canvas = new OffscreenCanvas(imageData.width, imageData.height);
  const ctx = canvas.getContext('2d');
  ctx.putImageData(imageData, 0, 0);
  const blob = await canvas.convertToBlob({
    type: 'image/webp',
    quality: lossless ? 1 : quality,
  });
  if (blob.type !== 'image/webp') {
    throw new Error('This browser cannot encode WebP');
  }
  return new Uint8Array(await blob.arrayBuffer());
}
