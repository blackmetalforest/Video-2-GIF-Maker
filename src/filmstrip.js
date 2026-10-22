/**
 * The frame timeline under the GIF: one thumbnail per converted frame.
 *
 * Clicking a thumbnail selects it — it shows large in the GIF view — and the
 * Set start / Set end buttons (or S and E) make the selection the GIF's first
 * or last frame. Each thumbnail says what will become of it:
 *
 *   start / end   the GIF's first and last frame, flagged
 *   skipped       inside the GIF but left out by Frame skip, greyed
 *   outside       before the start or after the end, dimmed
 *   pad           one of the extra frames taken either side of the video's
 *                 marks, in case a mark landed a frame off
 */

const THUMB_HEIGHT = 64;     // CSS px; the strip's height follows it

export class Filmstrip extends EventTarget {
  constructor(el) {
    super();
    this.el = el;
    this.thumbs = [];
    this.selected = -1;
    this.state = null;

    el.addEventListener('click', (e) => {
      const thumb = e.target.closest('.thumb');
      if (!thumb) return;
      this.select(+thumb.dataset.index);
      this.emit('select');
    });
    el.addEventListener('dblclick', (e) => {
      const thumb = e.target.closest('.thumb');
      if (thumb) this.emit('open', { index: +thumb.dataset.index });
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
    this.el.replaceChildren();
    this.thumbs = [];
    this.selected = -1;
    this.state = null;
  }

  /**
   * Start a new strip of `count` empty thumbnails, filled in by draw() as
   * frames arrive, so a long conversion shows its progress where it lands.
   *
   * @param {number} count
   * @param {number} aspect  width / height of a frame
   * @param {(i:number) => string} label  what to print under thumbnail i
   */
  reset(count, aspect, label) {
    this.clear();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const h = Math.round(THUMB_HEIGHT * dpr);
    const w = Math.max(8, Math.round(h * aspect));
    const cssW = Math.round(THUMB_HEIGHT * aspect);
    const fragment = document.createDocumentFragment();
    for (let i = 0; i < count; i++) {
      const thumb = document.createElement('button');
      thumb.type = 'button';
      thumb.className = 'thumb pending';
      thumb.dataset.index = String(i);
      thumb.tabIndex = -1;
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      canvas.style.width = `${cssW}px`;
      canvas.style.height = `${THUMB_HEIGHT}px`;
      const num = document.createElement('span');
      num.className = 'num';
      num.textContent = label(i);
      const flag = document.createElement('span');
      flag.className = 'flag';
      thumb.append(canvas, num, flag);
      fragment.append(thumb);
      this.thumbs.push(thumb);
    }
    this.el.append(fragment);
  }

  /** Paint thumbnail i from a decoded frame. */
  draw(i, image) {
    const thumb = this.thumbs[i];
    if (!thumb) return;
    const canvas = thumb.firstChild;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    thumb.classList.remove('pending');
  }

  /**
   * Mark every thumbnail with its role.
   * @param {{start:number, end:number, kept:Set<number>, padBefore:number, padAfter:number}} s
   */
  setState(s) {
    this.state = s;
    const n = this.thumbs.length;
    for (let i = 0; i < n; i++) {
      const t = this.thumbs[i];
      const outside = i < s.start || i > s.end;
      t.classList.toggle('outside', outside);
      t.classList.toggle('skipped', !outside && !s.kept.has(i));
      t.classList.toggle('start', i === s.start);
      t.classList.toggle('end', i === s.end);
      t.classList.toggle('pad', i < s.padBefore || i >= n - s.padAfter);
      t.lastChild.textContent = i === s.start && i === s.end ? 'START · END'
        : i === s.start ? 'START' : i === s.end ? 'END' : '';
    }
  }

  select(i, { scroll = true } = {}) {
    if (!this.thumbs.length) return;
    const k = Math.max(0, Math.min(this.thumbs.length - 1, i));
    this.thumbs[this.selected]?.classList.remove('selected');
    this.selected = k;
    const t = this.thumbs[k];
    t.classList.add('selected');
    if (scroll) t.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  /** Bring a thumbnail into the middle of the strip, for jumps from elsewhere. */
  centre(i) {
    const t = this.thumbs[i];
    if (!t) return;
    this.el.scrollLeft = t.offsetLeft - (this.el.clientWidth - t.offsetWidth) / 2;
  }

  onKey(e) {
    if (!this.thumbs.length || e.altKey || e.ctrlKey || e.metaKey) return;
    let next = null;
    if (e.key === 'ArrowLeft') next = this.selected - (e.shiftKey ? 10 : 1);
    else if (e.key === 'ArrowRight') next = this.selected + (e.shiftKey ? 10 : 1);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = this.thumbs.length - 1;
    else if (e.key === 's' || e.key === 'S') { this.emit('set', { which: 'start' }); e.preventDefault(); return; }
    else if (e.key === 'e' || e.key === 'E') { this.emit('set', { which: 'end' }); e.preventDefault(); return; }
    if (next === null) return;
    e.preventDefault();
    e.stopPropagation();
    this.select(next);
    this.emit('select');
  }
}
