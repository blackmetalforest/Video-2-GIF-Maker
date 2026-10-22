/**
 * Caption layout for the overlay text.
 *
 * Kept free of the DOM — every function here takes a 2D context and only ever
 * calls measureText on it — so the fiddly half can be tested in Node against a
 * stub, the same reason src/mtl-fix.js and src/mesh-list.js exist.
 *
 * The one rule that drives all of it: a caption must look the same at every
 * output size. A 200x200 GIF and a 1000x1000 GIF made from the same settings
 * should differ only in resolution, so nothing here is measured in pixels —
 * everything is a fraction of the image, resolved against the real width at
 * the last moment.
 */

/**
 * How many capital Ms fit across the image at the default size.
 *
 * Expressed in Ms rather than in pixels because it is the only way to state
 * the intent that survives a change of font: Impact is far narrower than
 * Arial Black at the same point size, and picking one pixel size for both
 * would make one of them wrong.
 *
 * Ten rather than the fourteen this started at — fourteen read as small on a
 * caption. The size control is still 100% at this default, so the numbers on
 * the slider did not move, only what they mean.
 */
export const MS_ACROSS = 10;

/** Fraction of the width kept clear at each side. */
const SIDE_MARGIN = 0.04;

/**
 * Clear space above and below the text, as a fraction of the height — 18px
 * on a 480px image.
 *
 * This is the real gap to the ink, not a margin the font then eats into. Every
 * font lands on the same figure; see inkOffsets().
 */
const EDGE_MARGIN = 18 / 480;

/**
 * The share of a span the text is allowed to use. Shared by the line box and
 * by the font sizing, which is what keeps a square image rendering exactly as
 * it did when both were derived from the width.
 */
const SPAN = 1 - SIDE_MARGIN * 2;

/**
 * The width a line of text actually has to live in.
 *
 * Both the font sizing and the wrapping measure against this same number,
 * which is the point: sizing MS_ACROSS Ms to the *full* width while wrapping
 * them inside the margins means the promised 14 wrap at 13.
 */
export function usableWidth(width) {
  return width * SPAN;
}

/**
 * The span the font size is derived from: the image's **height**.
 *
 * Deriving it from the width is the intuitive choice and the wrong one. It
 * ties how big a letter is to how wide the frame is, so widening 480x480 to
 * 1000x480 to fit a longer caption blows the text up instead — the letters
 * grow with the frame and you are no better off. Reading the height means the
 * size holds and the extra width does what you asked for: more characters on
 * the line.
 *
 * A square image is unchanged by this, which is the point — the defaults were
 * chosen at 480x480.
 */
export function fontBasis(height) {
  return height * SPAN;
}

/**
 * The default font size on a 480px-tall image, in pixels — about 38.5, using
 * Impact's M advance of roughly 0.82em. Stroke weight is quoted against this
 * so that "5" means five pixels there, which is where the default came from.
 */
const STROKE_REF = fontBasis(480) / (MS_ACROSS * 0.82);

/** Line spacing, as a multiple of the font size. Tight, the way a caption is. */
const LINE_HEIGHT = 1.12;

/**
 * Where a font's capitals actually sit inside the box they are placed in.
 *
 * Lines are positioned by their em box, but ink does not fill that box, and
 * how far short it falls is a property of the font. Placing by the box means
 * every face ends up with a different amount of clear space: balanced top
 * against bottom, but Arimo sat 3px further from the edge than Anton, because
 * Anton's capitals nearly fill their box while Arimo's leave room for
 * descenders that all-caps text never uses.
 *
 * So nothing is placed by the box. This reports how far below the placement
 * line the ink starts and ends, and layoutText() positions the *ink*, which
 * puts every font on the same margin.
 *
 * The probe is flat-topped, flat-bottomed capitals: no O to overshoot, no
 * descender. That keeps the figure constant for a font rather than shifting
 * as the wording changes — a caption is nearly always caps, and text that
 * does carry a descender will hang slightly below the line instead of
 * dragging the whole block up as you type.
 */
function inkOffsets(ctx, size) {
  const previous = ctx.textBaseline;
  ctx.textBaseline = 'top';
  const probe = ctx.measureText('MHEX');
  ctx.textBaseline = previous;

  const ascent = probe?.actualBoundingBoxAscent;
  const descent = probe?.actualBoundingBoxDescent;
  // No ink extents to be had: assume the ink fills the box, which is the
  // old behaviour and is never worse than refusing to draw.
  if (!Number.isFinite(ascent) || !Number.isFinite(descent)) {
    return { top: 0, bottom: size };
  }
  return { top: -ascent, bottom: descent };
}

/**
 * The font size, derived from the image **height**.
 *
 * Big enough that MS_ACROSS capital Ms would span a *square* image of this
 * height. On a square image that is literally how many fit; on a wider one
 * the letters stay that size and more of them fit, which is the whole reason
 * this reads the height.
 *
 * Measured rather than assumed: the M advance varies by more than 2x across
 * the fonts on offer, so the only way to keep the promise for all of them is
 * to ask the font itself.
 *
 * `scale` is the user's size control, where 1 is the default.
 */
export function fontPx(ctx, family, height, scale = 1) {
  const probe = 100;
  ctx.font = `${probe}px ${family}`;
  const m = ctx.measureText('M').width || probe * 0.82;
  // 0.999 so that the promised MS_ACROSS lands just inside the line rather
  // than exactly on it, where a rounding hair would wrap the last character.
  const size = (fontBasis(height) * probe * 0.999) / (MS_ACROSS * m);
  return Math.max(1, size * scale);
}

/**
 * Stroke width in pixels.
 *
 * Tied to the font size rather than straight to the image width. Both scale
 * with the image, so the "same at any size" rule holds either way, but this
 * one also keeps the outline in proportion when the size control is moved —
 * a fixed stroke swallows small text and looks like a hairline on big text.
 */
export function strokePx(weight, size) {
  return Math.max(0, weight) * (size / STROKE_REF);
}

/**
 * Break `text` to fit `maxWidth`, the way a text box does.
 *
 * Greedy on whitespace, and a word too long to fit on a line of its own is
 * broken mid-word rather than allowed to run off the edge — a caption is
 * often one shouted unspaced word, so that case is the rule, not the corner.
 */
export function wrapLines(ctx, text, maxWidth) {
  const source = String(text ?? '').trim();
  if (!source) return [];

  const lines = [];
  for (const paragraph of source.split(/\n/)) {
    const words = paragraph.trim().split(/\s+/).filter(Boolean);
    // An empty paragraph is a line the writer asked for by pressing Enter
    // twice, so it takes up a line rather than being silently swallowed.
    if (!words.length) { lines.push(''); continue; }

    let line = '';
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (!line || ctx.measureText(candidate).width <= maxWidth) {
        line = candidate;
        // A single word wider than the line still has to be cut.
        if (!line.includes(' ') && ctx.measureText(line).width > maxWidth) {
          const pieces = breakWord(ctx, line, maxWidth);
          lines.push(...pieces.slice(0, -1));
          line = pieces[pieces.length - 1];
        }
        continue;
      }
      lines.push(line);
      line = word;
      if (ctx.measureText(line).width > maxWidth) {
        const pieces = breakWord(ctx, line, maxWidth);
        lines.push(...pieces.slice(0, -1));
        line = pieces[pieces.length - 1];
      }
    }
    if (line) lines.push(line);
  }
  return lines;
}

/** Split one over-long word into chunks that each fit. */
function breakWord(ctx, word, maxWidth) {
  const out = [];
  let chunk = '';
  for (const ch of word) {
    const candidate = chunk + ch;
    if (chunk && ctx.measureText(candidate).width > maxWidth) {
      out.push(chunk);
      chunk = ch;
    } else {
      chunk = candidate;
    }
  }
  out.push(chunk);
  return out;
}

/**
 * Where every line of every block goes.
 *
 * Returns `[{ text, x, y }]` with y as the top of the line, ready for a
 * context with textBaseline 'top' and textAlign 'center'.
 *
 * The three blocks anchor differently, which is the whole point:
 *
 *  - top    grows downward from the top edge
 *  - middle stays centred on the image, so a second line pushes the first one
 *           up by half a line rather than hanging below the centre
 *  - bottom grows *upward* from the bottom edge, so extra lines make room for
 *           themselves instead of walking off the image
 */
export function layoutText(ctx, { top, middle, bottom }, opts) {
  const { width, height, family, scale = 1 } = opts;
  // Height sizes the letters; width only decides where the line breaks.
  const size = fontPx(ctx, family, height, scale);
  ctx.font = `${size}px ${family}`;

  const maxWidth = usableWidth(width);
  const lineStep = size * LINE_HEIGHT;
  const pad = height * EDGE_MARGIN;
  const ink = inkOffsets(ctx, size);
  const centre = width / 2;

  const blocks = [
    ['top', top],
    ['middle', middle],
    ['bottom', bottom],
  ];

  const placed = [];
  for (const [where, text] of blocks) {
    const lines = wrapLines(ctx, text, maxWidth);
    if (!lines.length) continue;

    // Everything is expressed against the ink, so `pad` is the clear space
    // you actually see whichever font is in use.
    const lastLine = (lines.length - 1) * lineStep;
    const inkHeight = lastLine + ink.bottom - ink.top;
    let y0;
    if (where === 'top') y0 = pad - ink.top;
    else if (where === 'middle') y0 = (height - inkHeight) / 2 - ink.top;
    else y0 = height - pad - ink.bottom - lastLine;

    lines.forEach((line, i) => placed.push({ text: line, x: centre, y: y0 + i * lineStep }));
  }
  return { size, lines: placed };
}

/** True when there is nothing to draw, so the whole pass can be skipped. */
export function isBlank({ top, middle, bottom } = {}) {
  return ![top, middle, bottom].some((t) => String(t ?? '').trim());
}

/**
 * Lay out the caption band that "On Top" mode grows above the image.
 *
 * The band is the one thing here whose *height* is an output rather than an
 * input: it is however tall the wrapped text needs it to be. That makes this
 * function load-bearing in a way the others are not — the preview and the
 * capture must arrive at the same number or the two disagree about how big
 * the exported image is, so both call this and neither measures its own.
 *
 * `height` is the height of the **render**, not of the finished image. The
 * font is sized by the same fontBasis() rule as every other mode, so the
 * letters in the band match the letters an In Front caption would have drawn,
 * and the 10-Ms-across promise holds. Sizing from the band's own height would
 * be circular anyway.
 *
 * Returns y values relative to the top of the band.
 */
export function layoutBand(ctx, text, { width, height, family, scale = 1 }) {
  const body = String(text ?? '').trim();
  if (!body) return { size: 0, bandHeight: 0, lines: [] };

  const size = fontPx(ctx, family, height, scale);
  ctx.font = `${size}px ${family}`;

  const lines = wrapLines(ctx, body, usableWidth(width));
  if (!lines.length) return { size, bandHeight: 0, lines: [] };

  // Same clear space as the in-image captions, measured to the ink the same
  // way, so a band caption and a top caption sit off their edge identically.
  const pad = height * EDGE_MARGIN;
  const ink = inkOffsets(ctx, size);
  const lineStep = size * LINE_HEIGHT;
  const lastLine = (lines.length - 1) * lineStep;
  const inkHeight = lastLine + ink.bottom - ink.top;

  // Rounded up: the band is a real number of pixels in the output, and
  // rounding down would shave the descender off the last line.
  const bandHeight = Math.ceil(pad * 2 + inkHeight);
  const y0 = pad - ink.top;
  const centre = width / 2;

  return {
    size,
    bandHeight,
    lines: lines.map((line, i) => ({ text: line, x: centre, y: y0 + i * lineStep })),
  };
}

/**
 * Paint the band: a white panel with black text and no outline.
 *
 * Fixed colours rather than settings, because the mode *is* the look — this
 * is the caption-above-the-picture format, and a stroke on black-on-white
 * would only ever spoil it. `y` offsets the whole band, which the preview
 * needs and the capture does not.
 */
export function drawBand(ctx, text, opts) {
  const { width, y = 0 } = opts;
  // Inside the save: laying out sets ctx.font, which is the caller's to keep.
  ctx.save();
  const { bandHeight, lines } = layoutBand(ctx, text, opts);
  if (!bandHeight) { ctx.restore(); return 0; }

  ctx.fillStyle = '#fff';
  ctx.fillRect(0, y, width, bandHeight);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillStyle = '#000';
  for (const line of lines) {
    if (line.text) ctx.fillText(line.text, line.x, y + line.y);
  }
  ctx.restore();
  return bandHeight;
}

/**
 * Paint the caption onto a 2D context sized `width` x `height`.
 *
 * Stroke first and fill second, with round joins: drawing the outline under
 * the letter rather than over it keeps the stroke from eating into the shape,
 * and mitred joins on a heavy weight throw spikes off the corners of an A.
 */
export function drawText(ctx, text, opts) {
  if (isBlank(text)) return;
  const { family, weight = 5 } = opts;

  ctx.save();
  const { size, lines } = layoutText(ctx, text, opts);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;
  ctx.fillStyle = '#fff';
  ctx.strokeStyle = '#000';
  /*
   * Held in a local, and never read back off the context. Assigning 0 to
   * lineWidth is *ignored* — the spec requires a finite value greater than
   * zero — so the context quietly keeps whatever it had, which is 1 by
   * default. Gating on ctx.lineWidth therefore saw 1, and a stroke of zero
   * still drew a hairline.
   */
  const outline = strokePx(weight, size);
  if (outline > 0) ctx.lineWidth = outline;

  // A caption is allowed to overrun the image, and at five thousand
  // characters most of it does. Lines that fall entirely outside are skipped
  // rather than handed to the rasteriser a hundred times over.
  const { height } = opts;
  for (const line of lines) {
    if (line.y + size < 0 || line.y > height) continue;
    if (!line.text) continue;
    if (outline > 0) ctx.strokeText(line.text, line.x, line.y);
    ctx.fillText(line.text, line.x, line.y);
  }
  ctx.restore();
}
