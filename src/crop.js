/**
 * The crop box: dragged over the whole frame in the GIF view.
 *
 * Shown only while Edit crop is ticked, when the GIF view stops showing the
 * finished GIF and shows the whole uncropped frame instead, with this box over
 * it. Everything outside the box is shaded. Drag inside to move it, drag an
 * edge or corner to resize it; with a fixed shape chosen, resizing keeps it.
 *
 * All positions are kept in the video's own pixels, so the box means the same
 * thing whatever size the view happens to be.
 */

import { clampCrop } from './compose.js';

const MIN_SIZE = 8;   // source pixels

export class CropTool extends EventTarget {
  constructor(layer, box) {
    super();
    this.layer = layer;
    this.box = box;
    this.target = null;      // the canvas the box sits over
    this.frameW = 1;
    this.frameH = 1;
    this.crop = { x: 0, y: 0, w: 1, h: 1 };
    this.aspect = 0;         // 0 = free
    this.drag = null;

    this.observer = new ResizeObserver(() => this.place());
    box.addEventListener('pointerdown', (e) => this.start(e));
    box.addEventListener('pointermove', (e) => this.move(e));
    box.addEventListener('pointerup', (e) => this.end(e));
    box.addEventListener('pointercancel', (e) => this.end(e));
  }

  show(target, frameW, frameH, crop, aspect) {
    this.target = target;
    this.frameW = frameW;
    this.frameH = frameH;
    this.crop = { ...crop };
    this.aspect = aspect;
    this.layer.hidden = false;
    this.observer.observe(target);
    this.place();
  }

  hide() {
    this.layer.hidden = true;
    if (this.target) this.observer.unobserve(this.target);
    this.target = null;
  }

  get visible() { return !this.layer.hidden; }

  /** Lay the layer exactly over the canvas as it is displayed. */
  place() {
    if (!this.target || this.layer.hidden) return;
    const stage = this.layer.parentElement.getBoundingClientRect();
    const r = this.target.getBoundingClientRect();
    Object.assign(this.layer.style, {
      left: `${r.left - stage.left}px`,
      top: `${r.top - stage.top}px`,
      width: `${r.width}px`,
      height: `${r.height}px`,
    });
    this.drawBox();
  }

  drawBox() {
    const { x, y, w, h } = this.crop;
    Object.assign(this.box.style, {
      left: `${(x / this.frameW) * 100}%`,
      top: `${(y / this.frameH) * 100}%`,
      width: `${(w / this.frameW) * 100}%`,
      height: `${(h / this.frameH) * 100}%`,
    });
  }

  /** Pointer position in source pixels. */
  point(e) {
    const r = this.layer.getBoundingClientRect();
    return {
      x: ((e.clientX - r.left) / r.width) * this.frameW,
      y: ((e.clientY - r.top) / r.height) * this.frameH,
    };
  }

  start(e) {
    if (e.button !== 0) return;
    e.preventDefault();
    this.box.setPointerCapture(e.pointerId);
    this.drag = {
      handle: e.target.dataset.h ?? 'move',
      from: this.point(e),
      crop: { ...this.crop },
    };
    this.box.classList.add('dragging');
  }

  move(e) {
    if (!this.drag) return;
    const p = this.point(e);
    const { handle, from, crop: c } = this.drag;
    const dx = p.x - from.x;
    const dy = p.y - from.y;
    const W = this.frameW;
    const H = this.frameH;

    if (handle === 'move') {
      this.crop = clampCrop({ ...c, x: c.x + dx, y: c.y + dy }, W, H);
    } else {
      // Work with the edges, then rebuild the rectangle.
      let left = c.x;
      let top = c.y;
      let right = c.x + c.w;
      let bottom = c.y + c.h;
      if (handle.includes('w')) left = Math.min(right - MIN_SIZE, Math.max(0, left + dx));
      if (handle.includes('e')) right = Math.max(left + MIN_SIZE, Math.min(W, right + dx));
      if (handle.includes('n')) top = Math.min(bottom - MIN_SIZE, Math.max(0, top + dy));
      if (handle.includes('s')) bottom = Math.max(top + MIN_SIZE, Math.min(H, bottom + dy));
      let w = right - left;
      let h = bottom - top;

      if (this.aspect > 0) {
        // The dragged dimension leads; a corner follows whichever moved more.
        const horizontal = handle === 'e' || handle === 'w';
        const vertical = handle === 'n' || handle === 's';
        const byWidth = horizontal || (!vertical && Math.abs(dx) >= Math.abs(dy));
        if (byWidth) h = w / this.aspect; else w = h * this.aspect;
        // Too big for the frame from this anchor: shrink to fit.
        const anchorX = handle.includes('w') ? right : left;
        const anchorY = handle.includes('n') ? bottom : top;
        const roomX = handle.includes('w') ? anchorX : horizontal || vertical ? W : W - anchorX;
        const roomY = handle.includes('n') ? anchorY : horizontal || vertical ? H : H - anchorY;
        const fit = Math.min(1, roomX / w, roomY / h);
        w *= fit;
        h *= fit;
        left = handle.includes('w') ? anchorX - w : vertical ? c.x + (c.w - w) / 2 : anchorX;
        top = handle.includes('n') ? anchorY - h : horizontal ? c.y + (c.h - h) / 2 : anchorY;
      }
      this.crop = clampCrop({ x: left, y: top, w, h }, W, H);
    }
    this.drawBox();
    this.dispatchEvent(new CustomEvent('input', { detail: this.crop }));
  }

  end(e) {
    if (!this.drag) return;
    this.drag = null;
    this.box.classList.remove('dragging');
    try { this.box.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    this.dispatchEvent(new CustomEvent('change', { detail: this.crop }));
  }
}
