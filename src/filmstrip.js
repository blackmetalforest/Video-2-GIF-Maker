/**
 * The frame timeline under the GIF: one thumbnail per converted frame.
 *
 * Clicking a thumbnail selects it — it shows large in the GIF view — and the
 * Start / End buttons under the GIF (or S and E) make the selection the GIF's
 * first or last frame. Each thumbnail says what will become of it:
 *
 *   start / end   the GIF's first and last frame, flagged
 *   skipped       inside the GIF but left out by Frame skip, greyed
 *   outside       before the start or after the end, dimmed
 *   pad           one of the extra frames taken either side of the video's
 *                 marks, in case a mark landed a frame off
 *
 * The strip is virtual: only the thumbnails in view, and a screen's worth
 * either side, exist at all. Every thumbnail is the same width, so which ones
 * are in view is arithmetic on the scroll position, and an empty track gives
 * the strip its full scrolling width. A real element per frame made every
 * page update cost time in proportion to the clip's length — converting a
 * 15,000-frame clip ran at a fraction of the speed of a short one — and a
 * drawn thumbnail per frame cost about 115 KB each on a high-density screen.
 */

const THUMB_HEIGHT = 64;     // CSS px of picture; the strip's height follows it
const THUMB_CHROME = 10;     // padding and border around the picture, both sides
const THUMB_GAP = 4;
const OVERSCAN = 1;          // screens' worth kept either side of the view
/*
 * Browsers stop laying out elements wider than about 33 million pixels, which
 * a strip of a quarter of a million thumbnails would pass. Past this width the
 * track stops growing and the scroll position is scaled instead: the
 * scrollbar covers the whole clip, and the thumbnails in view are placed
 * where they belong around it.
 */
const MAX_TRACK = 8_000_000;

export class Filmstrip extends EventTarget {
  constructor(el) {
    super();
    this.el = el;
    this.track = document.createElement('div');
    this.track.className = 'strip-track';
    el.append(this.track);
    this.count = 0;
    this.live = new Map();   // index → element, for the thumbnails in view
    this.selected = -1;
    this.state = null;
    this.getImage = () => null;
    this.label = (i) => String(i);
    this.pitch = 1;
    this.scheduled = false;

    el.addEventListener('scroll', () => this.schedule(), { passive: true });
    new ResizeObserver(() => this.schedule()).observe(el);
    el.addEventListener('click', (e) => {
      const thumb = e.target.closest('.thumb');
      if (!thumb) return;
      this.select(+thumb.dataset.index);
      this.emit('select');
    });
    // A vertical wheel scrolls the strip sideways, which is the only way it
    // goes; a trackpad's own sideways swipe still works as it always did.
    el.addEventListener('wheel', (e) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      el.scrollLeft += e.deltaY;
      e.preventDefault();
    }, { passive: false });
    el.addEventListener('keydown', (e) => this.onKey(e));
  }

  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  clear() {
    this.track.replaceChildren();
    this.track.style.width = '0px';
    this.live.clear();
    this.count = 0;
    this.selected = -1;
    this.state = null;
  }

  /**
   * Start a new strip of `count` thumbnails, filled in by draw() as frames
   * arrive, so a long conversion shows its progress where it lands.
   *
   * @param {number} count
   * @param {number} aspect  width / height of a frame
   * @param {(i:number) => string} label  what to print under thumbnail i
   * @param {(i:number) => CanvasImageSource|Promise<CanvasImageSource>|null} getImage
   *        frame i, or a promise of it once it is decoded
   */
  reset(count, aspect, label, getImage) {
    this.clear();
    this.count = count;
    this.label = label;
    this.getImage = getImage;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.cssW = Math.max(8, Math.round(THUMB_HEIGHT * aspect));
    this.pxW = Math.max(8, Math.round(this.cssW * dpr));
    this.pxH = Math.round(THUMB_HEIGHT * dpr);
    this.thumbW = this.cssW + THUMB_CHROME;
    this.pitch = this.thumbW + THUMB_GAP;
    this.fullW = count * this.pitch;
    this.trackW = Math.min(this.fullW, MAX_TRACK);
    this.track.style.width = `${this.trackW}px`;
    this.update();
  }

  /** Lay out the visible thumbnails once per animation frame at most. */
  schedule() {
    if (this.scheduled || !this.count) return;
    this.scheduled = true;
    requestAnimationFrame(() => { this.scheduled = false; this.update(); });
  }

  /** How far along the whole clip the view is, in unscaled pixels. */
  virtualLeft() {
    const view = this.el.clientWidth;
    const real = this.trackW - view;
    const virtual = this.fullW - view;
    return real > 0 ? this.el.scrollLeft * (virtual / real) : 0;
  }

  setVirtualLeft(left) {
    const view = this.el.clientWidth;
    const real = this.trackW - view;
    const virtual = this.fullW - view;
    this.el.scrollLeft = virtual > 0 ? Math.max(0, left) * (real / virtual) : 0;
  }

  /** Which thumbnails should exist now: those in view, and a screen either side. */
  range() {
    const view = this.el.clientWidth || 1000;
    const at = this.virtualLeft();
    const left = at - view * OVERSCAN;
    const right = at + view * (1 + OVERSCAN);
    return {
      first: Math.max(0, Math.floor(left / this.pitch)),
      last: Math.min(this.count - 1, Math.ceil(right / this.pitch)),
    };
  }

  /** Where thumbnail i sits in the track, allowing for a scaled scroll. */
  offset(i) {
    return i * this.pitch - this.virtualLeft() + this.el.scrollLeft;
  }

  update() {
    if (!this.count) return;
    const { first, last } = this.range();
    const scaled = this.fullW > this.trackW;
    for (const [i, el] of this.live) {
      if (i < first || i > last) { el.remove(); this.live.delete(i); }
      else if (scaled) el.style.transform = `translateX(${this.offset(i)}px)`;
    }
    const fragment = document.createDocumentFragment();
    for (let i = first; i <= last; i++) {
      if (!this.live.has(i)) {
        const el = this.make(i);
        this.live.set(i, el);
        fragment.append(el);
      }
    }
    this.track.append(fragment);
  }

  /** One thumbnail element, placed, marked and drawn if its frame is ready. */
  make(i) {
    const thumb = document.createElement('button');
    thumb.type = 'button';
    thumb.className = 'thumb pending';
    thumb.dataset.index = String(i);
    thumb.tabIndex = -1;
    thumb.style.width = `${this.thumbW}px`;
    thumb.style.transform = `translateX(${this.offset(i)}px)`;
    const canvas = document.createElement('canvas');
    canvas.width = this.pxW;
    canvas.height = this.pxH;
    canvas.style.width = `${this.cssW}px`;
    canvas.style.height = `${THUMB_HEIGHT}px`;
    const num = document.createElement('span');
    num.className = 'num';
    num.textContent = this.label(i);
    const flag = document.createElement('span');
    flag.className = 'flag';
    thumb.append(canvas, num, flag);
    this.mark(thumb, i);
    if (i === this.selected) thumb.classList.add('selected');
    this.paint(thumb, i);
    return thumb;
  }

  /** Frame i has been decoded: draw its thumbnail if it is in view. */
  draw(i) {
    const thumb = this.live.get(i);
    if (thumb) this.paint(thumb, i);
  }

  paint(thumb, i) {
    const image = this.getImage(i);
    if (!image) return;
    const draw = (picture) => {
      // Scrolled away, and the element reused for another frame, meanwhile.
      if (this.live.get(i) !== thumb) return;
      const canvas = thumb.firstChild;
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      try { ctx.drawImage(picture, 0, 0, canvas.width, canvas.height); } catch { return; }
      thumb.classList.remove('pending');
    };
    if (typeof image.then === 'function') image.then(draw, () => {});
    else draw(image);
  }

  /**
   * Mark every thumbnail with its role.
   * @param {{start:number, end:number, kept:Set<number>, padBefore:number, padAfter:number}} s
   */
  setState(s) {
    this.state = s;
    for (const [i, thumb] of this.live) this.mark(thumb, i);
  }

  mark(thumb, i) {
    const s = this.state;
    if (!s) return;
    const outside = i < s.start || i > s.end;
    thumb.classList.toggle('outside', outside);
    thumb.classList.toggle('skipped', !outside && !s.kept.has(i));
    thumb.classList.toggle('start', i === s.start);
    thumb.classList.toggle('end', i === s.end);
    thumb.classList.toggle('pad', i < s.padBefore || i >= this.count - s.padAfter);
    thumb.lastChild.textContent = i === s.start && i === s.end ? 'START · END'
      : i === s.start ? 'START' : i === s.end ? 'END' : '';
  }

  select(i, { scroll = true } = {}) {
    if (!this.count) return;
    const k = Math.max(0, Math.min(this.count - 1, i));
    this.live.get(this.selected)?.classList.remove('selected');
    this.selected = k;
    this.live.get(k)?.classList.add('selected');
    if (!scroll) return;
    // Into view, if it is not: just far enough, as scrollIntoView would.
    const left = k * this.pitch;
    const view = this.el.clientWidth;
    const at = this.virtualLeft();
    if (left < at) this.setVirtualLeft(left);
    else if (left + this.thumbW > at + view) this.setVirtualLeft(left + this.thumbW - view);
    this.update();
  }

  /** Bring a thumbnail into the middle of the strip, for jumps from elsewhere. */
  centre(i) {
    if (!this.count) return;
    this.setVirtualLeft(i * this.pitch - (this.el.clientWidth - this.thumbW) / 2);
    this.update();
  }

  onKey(e) {
    if (!this.count || e.altKey || e.ctrlKey || e.metaKey) return;
    let next = null;
    if (e.key === 'ArrowLeft') next = this.selected - (e.shiftKey ? 10 : 1);
    else if (e.key === 'ArrowRight') next = this.selected + (e.shiftKey ? 10 : 1);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = this.count - 1;
    else if (e.key === 's' || e.key === 'S') { this.emit('set', { which: 'start' }); e.preventDefault(); return; }
    else if (e.key === 'e' || e.key === 'E') { this.emit('set', { which: 'end' }); e.preventDefault(); return; }
    if (next === null) return;
    e.preventDefault();
    e.stopPropagation();
    this.select(next);
    this.emit('select');
  }
}
