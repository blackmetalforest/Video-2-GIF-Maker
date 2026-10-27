/**
 * GIF export, streamed.
 *
 * The important part is the *single shared palette*. Quantising each frame on
 * its own makes flat areas shimmer between frames — the colours crawl as the
 * palette is re-derived. Deriving one palette from a sample of all frames and
 * applying it to every frame keeps flat areas flat.
 *
 * gifenc is used precisely because it separates quantize() from applyPalette(),
 * which is exactly that model. Most JS GIF encoders quantise per frame.
 *
 * Unlike the spinning GIF maker, frames are never all held at once: a 10 s
 * clip at 720p is 300 frames of 3.7 MB each, more than a browser tab is
 * given. The palette is built from a handful of frames, then every frame is
 * rendered, quantised, written and dropped in turn — and the file itself
 * leaves in pieces as it grows (PIECE_BYTES).
 */

import { GIFEncoder, quantize, applyPalette } from '../../vendor/gifenc.esm.js';
import { maybeYield } from '../yield.js';

/*
 * The file is handed to a Blob in pieces of about this size as it is written,
 * and the encoder's buffer emptied. Kept in one buffer, a long GIF needed its
 * whole size twice over at the end (the buffer, then its copy) — hundreds of
 * megabytes for a long clip — and the browser's blob store, unlike a buffer,
 * can move what it holds to disk.
 */
const PIECE_BYTES = 8 * 1024 * 1024;

// How many frames to sample when building the shared palette.
const PALETTE_SAMPLES = 16;

/** Which frames the palette is built from: evenly spread, ends included. */
export function paletteSamples(count, samples = PALETTE_SAMPLES) {
  if (count <= samples) return Array.from({ length: count }, (_, i) => i);
  const out = new Set();
  for (let i = 0; i < samples; i++) out.add(Math.round((i * (count - 1)) / (samples - 1)));
  return [...out];
}

/** Opaque RGBA, with any alpha forced to 255 so quantize() sees plain colour. */
function opaque(imageData) {
  const rgba = new Uint8ClampedArray(imageData.data);   // copy: never mutate the caller's
  for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
  return rgba;
}

/**
 * Map pixels onto the palette with Floyd–Steinberg error diffusion.
 *
 * gifenc has no dithering of its own — applyPalette() picks the nearest colour
 * per pixel and nothing more — so this is hand-rolled. It mirrors gifenc's own
 * performance trick: cache nearest-colour lookups in an rgb565-keyed table,
 * because the linear scan over 256 palette entries is by far the hot path.
 *
 * Error is carried on two row buffers rather than a full-image float buffer,
 * which keeps memory flat regardless of output size.
 */
function applyPaletteDithered(rgba, palette, width, height) {
  const out = new Uint8Array(width * height);
  const cache = new Array(65536);
  const size = palette.length;

  const nearest = (r, g, b) => {
    // Same rgb565 key gifenc uses for its cache.
    const key = ((r << 8) & 0xf800) | ((g << 2) & 0x03e0) | (b >> 3);
    const hit = cache[key];
    if (hit !== undefined) return hit;
    let best = 0;
    let bestDist = Infinity;
    for (let i = 0; i < size; i++) {
      const p = palette[i];
      const dr = p[0] - r;
      let dist = dr * dr;
      if (dist >= bestDist) continue;
      const dg = p[1] - g;
      dist += dg * dg;
      if (dist >= bestDist) continue;
      const db = p[2] - b;
      dist += db * db;
      if (dist < bestDist) { bestDist = dist; best = i; }
    }
    cache[key] = best;
    return best;
  };

  let curr = new Float32Array(width * 3);
  let next = new Float32Array(width * 3);
  const seed = (row, target) => {
    for (let x = 0; x < width; x++) {
      const s = (row * width + x) * 4;
      target[x * 3] = rgba[s];
      target[x * 3 + 1] = rgba[s + 1];
      target[x * 3 + 2] = rgba[s + 2];
    }
  };
  seed(0, curr);

  for (let y = 0; y < height; y++) {
    if (y + 1 < height) seed(y + 1, next);
    for (let x = 0; x < width; x++) {
      const at = x * 3;

      const r = curr[at] < 0 ? 0 : curr[at] > 255 ? 255 : curr[at];
      const g = curr[at + 1] < 0 ? 0 : curr[at + 1] > 255 ? 255 : curr[at + 1];
      const b = curr[at + 2] < 0 ? 0 : curr[at + 2] > 255 ? 255 : curr[at + 2];

      const index = nearest(r | 0, g | 0, b | 0);
      out[y * width + x] = index;

      const chosen = palette[index];
      const er = r - chosen[0];
      const eg = g - chosen[1];
      const eb = b - chosen[2];

      // Floyd–Steinberg: 7/16 right, 3/16 below-left, 5/16 below, 1/16 below-right.
      if (x + 1 < width) {
        curr[at + 3] += (er * 7) / 16;
        curr[at + 4] += (eg * 7) / 16;
        curr[at + 5] += (eb * 7) / 16;
      }
      if (y + 1 < height) {
        if (x > 0) {
          next[at - 3] += (er * 3) / 16;
          next[at - 2] += (eg * 3) / 16;
          next[at - 1] += (eb * 3) / 16;
        }
        next[at] += (er * 5) / 16;
        next[at + 1] += (eg * 5) / 16;
        next[at + 2] += (eb * 5) / 16;
        if (x + 1 < width) {
          next[at + 3] += er / 16;
          next[at + 4] += eg / 16;
          next[at + 5] += eb / 16;
        }
      }
    }
    const swap = curr; curr = next; next = swap;
  }
  return out;
}

/**
 * Encode a GIF from frames that are rendered on demand.
 *
 * @param {object} opts
 * @param {number} opts.count            how many frames
 * @param {(indices:number[]) => AsyncIterable<ImageData>} opts.render
 *        yields the frames at those indices, in order, one at a time
 * @param {number[]} opts.delays         per-frame delays in ms, on the 10 ms grid
 * @param {number} [opts.colours=256]    palette size, 2–256
 * @param {boolean} [opts.dither=true]
 * @param {(done:number, total:number) => void} [opts.onProgress]
 * @param {() => boolean} [opts.cancelled]
 * @param {number} [opts.pieceBytes]    how big a piece leaves the encoder at
 * @returns {Promise<Blob>}
 */
export async function encodeGif({ count, render, delays, colours = 256, dither = true,
                                  onProgress = null, cancelled = () => false,
                                  pieceBytes = PIECE_BYTES }) {
  if (!count) throw new Error('No frames to encode');
  const size = Math.max(2, Math.min(256, Math.round(colours)));

  // Pass one: the palette, from a spread of frames joined into one buffer.
  const sampled = [];
  for await (const frame of render(paletteSamples(count))) {
    if (cancelled()) throw new DOMException('Cancelled', 'AbortError');
    sampled.push(opaque(frame));
  }
  const total = sampled.reduce((n, f) => n + f.length, 0);
  const merged = new Uint8ClampedArray(total);
  let at = 0;
  for (const rgba of sampled) { merged.set(rgba, at); at += rgba.length; }
  sampled.length = 0;
  const palette = quantize(merged, size, { format: 'rgb565' });

  // Pass two: every frame, in order.
  const gif = GIFEncoder({ initialCapacity: Math.max(4096, pieceBytes * 2) });
  const pieces = [];
  let i = 0;
  const all = Array.from({ length: count }, (_, k) => k);
  for await (const frame of render(all)) {
    if (cancelled()) throw new DOMException('Cancelled', 'AbortError');
    const { width, height } = frame;
    const rgba = opaque(frame);
    const index = dither
      ? applyPaletteDithered(rgba, palette, width, height)
      : applyPalette(rgba, palette, 'rgb565');
    gif.writeFrame(index, width, height, {
      palette: i === 0 ? palette : undefined,
      delay: delays[i],
      repeat: 0,                       // loop forever
      first: i === 0,
    });
    i++;
    if (gif.stream.bytesView().length >= pieceBytes) {
      pieces.push(new Blob([gif.stream.bytesView()]));
      gif.stream.reset();
    }
    if (onProgress) onProgress(i, count);
    await maybeYield();
  }
  gif.finish();
  pieces.push(new Blob([gif.stream.bytesView()]));
  return new Blob(pieces, { type: 'image/gif' });
}
