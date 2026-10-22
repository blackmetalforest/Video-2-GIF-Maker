/**
 * Animated PNG, assembled from still PNGs.
 *
 * The best quality of the animated exports: every frame is lossless and full
 * colour. Each frame is encoded as an ordinary PNG (src/encoders/png.js) and
 * this re-stitches their chunks into one file.
 *
 * APNG adds three chunk types to a normal PNG:
 *   acTL  animation control: frame count + loop count (once, before IDAT)
 *   fcTL  frame control: size, offset, delay, disposal (before each frame)
 *   fdAT  frame data: same payload as IDAT but prefixed with a sequence number
 *
 * The first frame stays a plain IDAT (preceded by its own fcTL) so that
 * non-APNG viewers still show a valid still image.
 *
 * Delays are a rational number (num/den). Using den = 1000 makes the numerator
 * milliseconds, giving APNG the same 1 ms precision as WebP — finer than GIF.
 *
 * Reference: https://wiki.mozilla.org/APNG_Specification
 */

import { chunk, readChunks, writeU32 } from './png.js';

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * Build an animated PNG from encoded still PNGs.
 *
 * @param {Array<{data: Uint8Array, delay: number}>} frames stills + ms delays
 * @param {{width:number, height:number, loop?:number}} opts
 * @returns {Uint8Array}
 */
export function muxApng(frames, opts) {
  if (!frames?.length) throw new Error('No frames to mux');
  const { width, height, loop = 0 } = opts;

  const parts = [new Uint8Array(SIGNATURE)];
  let sequence = 0;
  let headerWritten = false;

  frames.forEach((frame, index) => {
    const chunks = readChunks(frame.data);
    const ihdr = chunks.find((c) => c.type === 'IHDR');
    if (!ihdr) throw new Error('PNG frame has no IHDR');

    if (!headerWritten) {
      parts.push(chunk('IHDR', ihdr.data));
      // Carry over palette/transparency chunks if the encoder produced them.
      for (const c of chunks) {
        if (c.type === 'PLTE' || c.type === 'tRNS') parts.push(chunk(c.type, c.data));
      }
      const actl = new Uint8Array(8);
      writeU32(actl, 0, frames.length);
      writeU32(actl, 4, loop);
      parts.push(chunk('acTL', actl));
      headerWritten = true;
    }

    // fcTL describes the frame that follows it.
    const fctl = new Uint8Array(26);
    writeU32(fctl, 0, sequence++);
    writeU32(fctl, 4, width);
    writeU32(fctl, 8, height);
    writeU32(fctl, 12, 0);                     // x offset
    writeU32(fctl, 16, 0);                     // y offset
    const delay = Math.max(0, Math.round(frame.delay));
    fctl[20] = (delay >>> 8) & 0xff;           // delay numerator (ms)
    fctl[21] = delay & 0xff;
    fctl[22] = 0x03;                           // denominator 1000 -> ms
    fctl[23] = 0xe8;
    // Dispose to background and do not blend: every frame is a full, opaque
    // replacement of the one before.
    fctl[24] = 1;                              // dispose_op = BACKGROUND
    fctl[25] = 0;                              // blend_op = SOURCE
    parts.push(chunk('fcTL', fctl));

    for (const c of chunks) {
      if (c.type !== 'IDAT') continue;
      if (index === 0) {
        // First frame stays a plain IDAT so ordinary PNG viewers still work.
        parts.push(chunk('IDAT', c.data));
      } else {
        const fdat = new Uint8Array(4 + c.data.length);
        writeU32(fdat, 0, sequence++);
        fdat.set(c.data, 4);
        parts.push(chunk('fdAT', fdat));
      }
    }
  });

  parts.push(chunk('IEND', new Uint8Array(0)));

  const total = parts.reduce((n, p) => n + p.length, 0);
  const file = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { file.set(p, at); at += p.length; }
  return file;
}
