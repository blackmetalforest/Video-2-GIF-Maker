/**
 * Where converted frames live: each one a still WebP, decoded on demand.
 *
 * Holding frames as ready-to-draw images costs four bytes a pixel — a single
 * 1080p frame is 8 MB, and a few thousand of anything exhausts a tab, which
 * then freezes, or shows the "sad face" of a canvas whose memory ran out. A
 * WebP still of the same frame is typically a twentieth of that or less, and
 * the browser keeps it in its blob store, which can spill to disk when memory
 * is short. So hundreds of thousands of small frames fit where a few thousand
 * did not.
 *
 * Decoding a small WebP takes well under a millisecond, so the preview, the
 * thumbnails and every export decode what they need when they need it,
 * through a cache of recently used frames capped by size, and ask ahead
 * (prefetch) when they know what comes next.
 */

/** Decoded frames kept for reuse, in bytes (four a pixel). */
const CACHE_BYTES = 256 * 1024 * 1024;

export class FrameStore {
  /**
   * @param {{width:number, height:number}} size  every frame's size
   */
  constructor({ width, height }) {
    this.width = width;
    this.height = height;
    this.blobs = [];
    this.bytes = 0;
    this.cache = new Map();      // index → ImageBitmap, oldest first
    this.pending = new Map();    // index → Promise<ImageBitmap>
    this.cacheLimit = Math.max(8, Math.floor(CACHE_BYTES / (width * height * 4)));
    this.disposed = false;
  }

  get count() { return this.blobs.length; }

  set(i, blob) {
    this.blobs[i] = blob;
    this.bytes += blob.size;
  }

  /** Frame i, ready to draw, if it is in the cache; null otherwise. */
  peek(i) {
    const bitmap = this.cache.get(i);
    if (!bitmap) return null;
    // Most recently used goes to the back.
    this.cache.delete(i);
    this.cache.set(i, bitmap);
    return bitmap;
  }

  /** Frame i, ready to draw. Decodes it, once, if it is not cached. */
  get(i) {
    const hit = this.peek(i);
    if (hit) return Promise.resolve(hit);
    const inflight = this.pending.get(i);
    if (inflight) return inflight;
    const blob = this.blobs[i];
    if (!blob) return Promise.reject(new Error(`Frame ${i} has not been converted.`));
    const job = createImageBitmap(blob).then((bitmap) => {
      this.pending.delete(i);
      if (this.disposed) { bitmap.close(); throw new DOMException('Gone', 'AbortError'); }
      this.cache.set(i, bitmap);
      this.trim();
      return bitmap;
    }, (err) => { this.pending.delete(i); throw err; });
    this.pending.set(i, job);
    return job;
  }

  /** Start decoding frames that are about to be wanted. */
  prefetch(indices) {
    for (const i of indices) {
      if (i >= 0 && i < this.blobs.length && !this.cache.has(i) && !this.pending.has(i)) {
        this.get(i).catch(() => {});
      }
    }
  }

  /** Drop the least recently used frames past the limit. */
  trim() {
    while (this.cache.size > this.cacheLimit) {
      const [oldest, bitmap] = this.cache.entries().next().value;
      this.cache.delete(oldest);
      bitmap.close();
    }
  }

  dispose() {
    this.disposed = true;
    for (const bitmap of this.cache.values()) bitmap.close();
    this.cache.clear();
    this.pending.clear();
    this.blobs = [];
    this.bytes = 0;
  }
}
