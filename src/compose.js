/**
 * Building one finished GIF frame: crop, scale, caption.
 *
 * The preview and every export call the same functions, which is what makes
 * the preview honest — it is not an approximation of the output, it is the
 * output, drawn from a smaller copy of each frame.
 *
 * The finished image is the cropped video scaled to the output size, with
 * the caption over it — or, in On Top mode, under a white band the image
 * grows above the picture.
 */

import { drawText, drawBand, layoutBand, isBlank } from './overlay-text.js';

/** Clamp a crop rectangle into a frame of `w` x `h`, whole pixels, at least 2x2. */
export function clampCrop(crop, w, h) {
  const cw = Math.max(2, Math.min(w, Math.round(crop.w)));
  const ch = Math.max(2, Math.min(h, Math.round(crop.h)));
  const x = Math.max(0, Math.min(w - cw, Math.round(crop.x)));
  const y = Math.max(0, Math.min(h - ch, Math.round(crop.y)));
  return { x, y, w: cw, h: ch };
}

/** The largest rectangle of `aspect` (w/h) centred in a `w` x `h` frame. */
export function centredCrop(w, h, aspect) {
  if (!(aspect > 0)) return { x: 0, y: 0, w, h };
  let cw = w;
  let ch = w / aspect;
  if (ch > h) { ch = h; cw = h * aspect; }
  return clampCrop({ x: (w - cw) / 2, y: (h - ch) / 2, w: cw, h: ch }, w, h);
}

/**
 * Output pixel size for a crop: the longer side becomes `longSide`, the
 * shorter follows the crop's shape. Never larger than the crop itself —
 * scaling a video up only makes a bigger file of the same detail — unless
 * asked for in so many words with a typed size.
 */
export function sizeForLongSide(crop, longSide) {
  const long = Math.max(crop.w, crop.h);
  const target = longSide > 0 ? Math.min(longSide, long) : long;
  const scale = target / long;
  return {
    width: Math.max(2, Math.round(crop.w * scale)),
    height: Math.max(2, Math.round(crop.h * scale)),
  };
}

/** Even sizes help some players; GIF does not care, so this only rounds. */
export function sizeForWidth(crop, width) {
  const w = Math.max(2, Math.round(width));
  return { width: w, height: Math.max(2, Math.round((w * crop.h) / crop.w)) };
}
export function sizeForHeight(crop, height) {
  const h = Math.max(2, Math.round(height));
  return { width: Math.max(2, Math.round((h * crop.w) / crop.h)), height: h };
}

/**
 * The caption, drawn once at output size onto its own transparent layer, to
 * be laid over every frame. Text layout is the slow part of a caption; doing
 * it once instead of per frame keeps the preview smooth.
 *
 * Returns `{ layer, band }`: the layer is the full finished size, band
 * included, and `band` is the band's height (0 unless On Top).
 */
export function captionLayer(caption, width, height) {
  if (!caption) return { layer: null, band: 0 };
  let band = 0;
  if (caption.mode === 'ontop') {
    const probe = new OffscreenCanvas(1, 1).getContext('2d');
    band = layoutBand(probe, caption.band, { ...caption, width, height }).bandHeight;
    if (!band) return { layer: null, band: 0 };
  } else if (isBlank(caption.text)) {
    return { layer: null, band: 0 };
  }
  const layer = new OffscreenCanvas(width, height + band);
  const ctx = layer.getContext('2d');
  if (caption.mode === 'ontop') drawBand(ctx, caption.band, { ...caption, width, height, y: 0 });
  else drawText(ctx, caption.text, { ...caption, width, height });
  return { layer, band };
}

/**
 * Draw one finished frame.
 *
 * @param {CanvasRenderingContext2D|OffscreenCanvasRenderingContext2D} ctx
 *        sized width x (height + band)
 * @param {CanvasImageSource} image  the frame, at any scale
 * @param {{x,y,w,h}} crop           in the image's own pixels
 * @param {{width:number, height:number, band:number, layer:OffscreenCanvas|null}} out
 */
export function drawFrame(ctx, image, crop, out) {
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(image, crop.x, crop.y, crop.w, crop.h, 0, out.band, out.width, out.height);
  if (out.layer) ctx.drawImage(out.layer, 0, 0);
}

/**
 * Scale a crop rectangle given in source pixels into an image that is a
 * scaled copy of the source.
 */
export function scaleCrop(crop, factor) {
  return { x: crop.x * factor, y: crop.y * factor, w: crop.w * factor, h: crop.h * factor };
}
