/**
 * The video player: the <video> element, the scrub bar, frame stepping and
 * the timecode.
 *
 * The browser plays the file — smoothly, with sound, on the graphics card —
 * and this keeps track of *which frame* is on screen. That comes from
 * requestVideoFrameCallback, which reports the exact timestamp of every frame
 * the moment it is presented; the frame index is then looked up in the
 * source's table of real frame times (src/source.js), so the timecode always
 * names the frame you can see, playing or paused.
 *
 * Seeking goes the other way: to show frame i the video is sent to the middle
 * of frame i, never its edge, where rounding could land on a neighbour.
 */

export class Player extends EventTarget {
  /**
   * @param {object} els
   * @param {HTMLVideoElement} els.video
   * @param {HTMLElement} els.scrub        the scrub bar
   * @param {HTMLElement} els.head         its playhead
   * @param {HTMLElement} els.clip         the marked region
   * @param {HTMLElement} els.markIn
   * @param {HTMLElement} els.markOut
   */
  constructor(els) {
    super();
    this.els = els;
    this.video = els.video;
    this.source = null;
    this.frame = 0;
    this.target = null;        // the frame a seek is on its way to
    this.pendingTime = null;   // a scrub position waiting for the current seek
    this.marks = { in: null, out: null };
    this.url = null;
    this.hasFrameCallback = 'requestVideoFrameCallback' in HTMLVideoElement.prototype;

    this.video.addEventListener('seeked', () => this.onSeeked());
    this.video.addEventListener('play', () => this.emit('state'));
    this.video.addEventListener('pause', () => { this.syncFromTime(); this.emit('state'); });
    this.video.addEventListener('ended', () => this.emit('state'));
    this.video.addEventListener('volumechange', () => this.emit('state'));
    this.video.addEventListener('timeupdate', () => {
      if (!this.hasFrameCallback) this.syncFromTime();
    });
    this.bindScrub();
  }

  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  /**
   * Point the player at a file. Resolves once the first frame is ready to
   * show; rejects if the browser cannot play it, so the caller can offer the
   * ffmpeg route instead.
   */
  load(blob, source) {
    this.unload();
    this.source = source;
    // An address plays as it is; a File or Blob through an object URL.
    this.url = typeof blob === 'string' ? blob : URL.createObjectURL(blob);
    const video = this.video;
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (error) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        video.removeEventListener('loadeddata', ok);
        video.removeEventListener('error', bad);
        if (error) reject(error); else resolve();
      };
      const ok = () => {
        // Some browsers "load" a codec they cannot decode and show nothing:
        // a video with no size is one of those.
        if (!video.videoWidth || !video.videoHeight) {
          finish(new Error('The browser loaded the video but cannot show its picture.'));
          return;
        }
        this.frame = 0;
        this.watchFrames();
        this.emit('frame');
        finish(null);
      };
      const bad = () => {
        const code = video.error?.code;
        finish(new Error(code === 4
          ? 'This browser cannot play this video.'
          : `The video could not be loaded${video.error?.message ? ` (${video.error.message})` : ''}.`));
      };
      // A file the browser chokes on silently would otherwise hang forever.
      const timer = setTimeout(() => finish(new Error('The video took too long to load.')), 30000);
      video.addEventListener('loadeddata', ok);
      video.addEventListener('error', bad);
      video.src = this.url;
      video.load();
    });
  }

  unload() {
    this.video.pause();
    this.video.removeAttribute('src');
    this.video.load();
    if (this.url?.startsWith('blob:')) URL.revokeObjectURL(this.url);
    this.url = null;
    this.source = null;
    this.frame = 0;
    this.target = null;
    this.pendingTime = null;
    this.marks = { in: null, out: null };
    this.drawMarks();
  }

  get loaded() { return !!this.source; }
  get playing() { return !this.video.paused && !this.video.ended; }

  /* ------------------------------------------------------ which frame */

  /**
   * Follow every presented frame. The callback has to be re-registered each
   * time, and that is all the loop is — it costs nothing while paused,
   * because no frames are presented.
   */
  watchFrames() {
    if (!this.hasFrameCallback) return;
    const video = this.video;
    const source = this.source;
    const tick = (_now, meta) => {
      if (this.source !== source) return;      // a new file replaced this one
      const index = source.indexAt(meta.mediaTime);
      // While paused, frames only change because of a seek, and a callback
      // can arrive late — after a newer seek has already landed, when a fast
      // scrub queues several. One that does not match where the element now
      // is belongs to an older seek, and would drag the readout back to it.
      const stale = !this.playing &&
        (video.seeking || this.pendingTime !== null || index !== source.indexAt(video.currentTime));
      if (!stale) this.setFrame(index);
      video.requestVideoFrameCallback(tick);
    };
    video.requestVideoFrameCallback(tick);
  }

  /** Without frame callbacks, the best available: the element's own clock. */
  syncFromTime() {
    if (!this.source) return;
    if (this.hasFrameCallback && this.playing) return;
    this.setFrame(this.source.indexAt(this.video.currentTime));
  }

  setFrame(index) {
    if (index === this.frame && this.target === null) return;
    this.frame = index;
    if (this.target === index) this.target = null;
    this.drawHead();
    this.emit('frame');
  }

  onSeeked() {
    if (this.pendingTime !== null) {
      const t = this.pendingTime;
      this.pendingTime = null;
      this.video.currentTime = t;
      return;
    }
    // Frame callbacks report the new frame themselves; this is the backstop
    // for a browser that does not fire one for a paused seek.
    if (!this.playing) this.setFrame(this.source.indexAt(this.video.currentTime));
    this.target = null;
  }

  /* ---------------------------------------------------------- moving */

  seekFrame(index) {
    if (!this.source) return;
    const k = Math.max(0, Math.min(this.source.count - 1, index));
    this.video.pause();
    this.target = k;
    this.seekTo(this.source.seekTime(k));
    // Move the readout at once; the picture follows when the seek lands.
    this.frame = k;
    this.drawHead();
    this.emit('frame');
  }

  /** Step by frames. Repeated presses add up even while a seek is in flight. */
  step(frames) {
    if (!this.source) return;
    const from = this.target ?? this.frame;
    this.seekFrame(from + frames);
  }

  /** Jump by seconds, landing on whichever frame is showing then. */
  stepSeconds(seconds) {
    if (!this.source) return;
    const from = this.source.times[this.target ?? this.frame];
    this.seekFrame(this.source.indexAt(from + seconds));
  }

  /**
   * Seek, but never queue seeks: while one is running only the newest
   * request is kept, so dragging the scrub bar never falls behind the mouse.
   */
  seekTo(time) {
    if (this.video.seeking) this.pendingTime = time;
    else this.video.currentTime = time;
  }

  togglePlay() {
    if (!this.source) return;
    if (this.playing) { this.video.pause(); return; }
    // Played to the end: start again from the top, as players do.
    if (this.video.ended || this.frame >= this.source.count - 1) this.video.currentTime = 0;
    this.target = null;
    this.video.play().catch(() => {});
  }

  /* --------------------------------------------------------- scrubbing */

  bindScrub() {
    const scrub = this.els.scrub;
    let dragging = false;
    const at = (e) => {
      const box = scrub.getBoundingClientRect();
      const x = Math.max(0, Math.min(1, (e.clientX - box.left) / box.width));
      return x * this.source.duration;
    };
    const move = (e) => {
      const t = at(e);
      const k = this.source.indexAt(t);
      this.target = k;
      this.frame = k;
      this.drawHead();
      this.emit('frame');
      this.seekTo(this.source.seekTime(k));
    };
    scrub.addEventListener('pointerdown', (e) => {
      if (!this.source || e.button !== 0) return;
      // No text selection and no native drag: either would take the gesture
      // over, and the next press would drag the selection instead of the
      // playhead (the closed hand with a plus).
      e.preventDefault();
      window.getSelection()?.removeAllRanges();
      dragging = true;
      this.wasPlaying = this.playing;
      this.video.pause();
      scrub.setPointerCapture(e.pointerId);
      scrub.classList.add('dragging');
      move(e);
    });
    scrub.addEventListener('pointermove', (e) => { if (dragging) move(e); });
    const end = () => {
      if (!dragging) return;
      dragging = false;
      scrub.classList.remove('dragging');
      if (this.wasPlaying) this.video.play().catch(() => {});
    };
    scrub.addEventListener('pointerup', end);
    scrub.addEventListener('pointercancel', end);
  }

  /** Where frame `i` sits along the scrub bar, 0–100. */
  percent(i) {
    if (!this.source) return 0;
    return (Math.max(0, this.source.times[i]) / this.source.duration) * 100;
  }

  drawHead() {
    if (!this.source) return;
    this.els.head.style.left = `${this.percent(this.frame)}%`;
    this.els.scrub.setAttribute('aria-valuemax', String(this.source.count - 1));
    this.els.scrub.setAttribute('aria-valuenow', String(this.frame));
    this.els.scrub.setAttribute('aria-valuetext', this.source.timecode(this.frame));
  }

  /* ------------------------------------------------------------- marks */

  setMark(which, index) {
    this.marks[which] = index;
    // Marks the wrong way round are swapped rather than refused: someone who
    // marked the end first meant the same clip.
    const { in: a, out: b } = this.marks;
    if (a !== null && b !== null && a > b) this.marks = { in: b, out: a };
    this.drawMarks();
    this.emit('marks');
  }

  drawMarks() {
    const { in: a, out: b } = this.marks;
    const { markIn, markOut, clip } = this.els;
    markIn.hidden = a === null;
    markOut.hidden = b === null;
    if (a !== null) markIn.style.left = `${this.percent(a)}%`;
    if (b !== null && this.source) {
      // The end mark sits at the far edge of its frame: the clip includes it.
      const t = this.source.times[b] + this.source.durations[b];
      markOut.style.left = `${(t / this.source.duration) * 100}%`;
    }
    clip.hidden = a === null || b === null;
    if (!clip.hidden) {
      const left = this.percent(a);
      clip.style.left = `${left}%`;
      clip.style.width = `${parseFloat(markOut.style.left) - left}%`;
    }
  }
}
