/**
 * The video file: what is in it, where every frame sits, and decoding them.
 *
 * Mediabunny reads the container (MP4, MOV, WebM, MKV and more) in pure
 * JavaScript and hands the packets to the browser's own WebCodecs decoder,
 * so decoding is native and usually on the graphics card. What it buys over
 * the <video> element is exactness: every frame's real presentation time is
 * read from the file, so "frame 14 of second 83" is a fact rather than a
 * guess from the frame rate, and asking for a frame returns exactly that
 * frame — not whichever one a seek happened to land near.
 *
 * The <video> element (src/player.js) is still what plays the file, for
 * smooth playback and sound. The two agree on time because both use the
 * container's own timestamps.
 */

import {
  Input, BlobSource, ALL_FORMATS, EncodedPacketSink, VideoSampleSink,
} from '../vendor/mediabunny.min.mjs';

/** Codec names as people know them. */
const CODEC_NAMES = {
  avc: 'H.264', hevc: 'H.265', vp8: 'VP8', vp9: 'VP9', av1: 'AV1',
};

/** Why a file cannot be used natively; the fallback offer quotes these. */
export class NotDecodable extends Error {
  constructor(message, { reason, codec = null, container = null } = {}) {
    super(message);
    this.name = 'NotDecodable';
    this.reason = reason;          // 'container' | 'no-video' | 'codec'
    this.codec = codec;
    this.container = container;
  }
}

/**
 * Open a file and index every frame in it.
 *
 * Throws NotDecodable when the container cannot be read or the browser has
 * no decoder for the codec; anything else is a real error.
 *
 * @param {Blob} file
 * @param {{onProgress?: (fraction:number) => void, signal?: AbortSignal}} opts
 */
export async function openVideo(file, { onProgress = null, signal = null } = {}) {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  let format;
  try {
    format = await input.getFormat();
  } catch {
    input.dispose?.();
    throw new NotDecodable('This kind of file cannot be read in the browser.', { reason: 'container' });
  }
  const container = format?.name ?? 'Unknown';

  const track = await input.getPrimaryVideoTrack();
  if (!track) {
    input.dispose?.();
    throw new NotDecodable('There is no video in this file.', { reason: 'no-video', container });
  }

  const codec = track.codec;
  const codecName = CODEC_NAMES[codec] ?? (codec ? codec.toUpperCase() : 'an unknown codec');
  let decodable = false;
  try { decodable = await track.canDecode(); } catch { decodable = false; }
  if (!decodable) {
    input.dispose?.();
    throw new NotDecodable(`This browser cannot decode ${codecName} video.`,
      { reason: 'codec', codec: codecName, container });
  }

  const { times, durations } = await indexFrames(track, { onProgress, signal });
  if (!times.length) {
    input.dispose?.();
    throw new NotDecodable('The video track has no frames.', { reason: 'no-video', container });
  }

  return new VideoSource({
    file, input, track, container, codec: codecName, times, durations,
  });
}

/**
 * Every frame's presentation time and duration, in presentation order.
 *
 * Packets come in *decode* order, which with B-frames is not the order they
 * are shown in, so the times are sorted. Only metadata is read — no packet
 * data and no decoding — so this costs a scan of the container's index.
 */
async function indexFrames(track, { onProgress, signal }) {
  const sink = new EncodedPacketSink(track);
  const end = await track.getDurationFromMetadata?.().catch(() => null)
    ?? await track.computeDuration();
  const pairs = [];
  let lastReport = 0;
  for await (const packet of sink.packets(undefined, undefined, { metadataOnly: true })) {
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    // A frame that ends before zero is decoder pre-roll and never shown.
    if (packet.timestamp + Math.max(packet.duration, 0) <= 0 && packet.timestamp < 0) continue;
    pairs.push(packet.timestamp, packet.duration);
    if (onProgress && end > 0 && pairs.length - lastReport > 2000) {
      lastReport = pairs.length;
      onProgress(Math.min(1, packet.timestamp / end));
    }
  }

  const count = pairs.length / 2;
  const order = Array.from({ length: count }, (_, i) => i)
    .sort((a, b) => pairs[a * 2] - pairs[b * 2]);
  const times = new Float64Array(count);
  const durations = new Float64Array(count);
  order.forEach((src, i) => { times[i] = pairs[src * 2]; });

  // A frame lasts until the next one starts. The container's own durations
  // are used only for the last frame, and only when they look sane: some
  // muxers write zero, or the whole GOP's length.
  const typical = medianStep(times);
  for (let i = 0; i < count; i++) {
    if (i + 1 < count) durations[i] = times[i + 1] - times[i];
    else {
      const own = pairs[order[i] * 2 + 1];
      durations[i] = own > 0 && own < typical * 4 ? own : typical;
    }
  }
  return { times, durations };
}

/**
 * The usual gap between frames. An average, because containers that store
 * whole milliseconds (WebM, MKV) give 30 fps as 33, 33, 34 ms, whose median
 * reads as 30.3 fps — but an average of only the ordinary gaps, so a
 * dropped frame or a pause cannot skew it.
 */
function medianStep(times) {
  const n = Math.min(times.length - 1, 600);
  if (n < 1) return 1 / 30;
  const gaps = [];
  for (let i = 0; i < n; i++) gaps.push(times[i + 1] - times[i]);
  const sorted = [...gaps].sort((a, b) => a - b);
  const median = sorted[n >> 1] || 1 / 30;
  let sum = 0;
  let count = 0;
  for (const g of gaps) if (g > median * 0.5 && g < median * 1.5) { sum += g; count++; }
  return count ? sum / count : median;
}

/**
 * A rate as people write it: whole numbers plainly, the NTSC rates by their
 * names, anything else to two places.
 */
export function formatFps(fps) {
  if (!(fps > 0)) return '?';
  for (const ntsc of [23.976, 29.97, 59.94, 119.88]) {
    if (Math.abs(fps - ntsc) < 0.005) return String(ntsc);
  }
  if (Math.abs(fps - Math.round(fps)) < 0.01) return String(Math.round(fps));
  return fps.toFixed(2);
}

export class VideoSource {
  constructor({ file, input, track, container, codec, times, durations }) {
    this.file = file;
    this.input = input;
    this.track = track;
    this.container = container;
    this.codec = codec;
    this.times = times;
    this.durations = durations;
    this.count = times.length;
    // After rotation, so a phone's portrait video is portrait here.
    this.width = track.displayWidth;
    this.height = track.displayHeight;
    this.typicalStep = medianStep(times);
    this.fps = 1 / this.typicalStep;
    this.duration = times[this.count - 1] + durations[this.count - 1];
    // Variable frame rate: phone footage often is. Timecodes still work —
    // they count real frames — but "30 fps" is then only an average.
    this.variable = this.count > 2 && this.isVariable();
  }

  isVariable() {
    const step = this.typicalStep;
    let odd = 0;
    const n = Math.min(this.count - 1, 2000);
    for (let i = 0; i < n; i++) {
      if (Math.abs(this.durations[i] - step) > step * 0.25) odd++;
    }
    return odd > n * 0.02;
  }

  /** The frame on screen at time `t`: the last one starting at or before it. */
  indexAt(t) {
    const times = this.times;
    // Half a millisecond of slack, because a time read back from the <video>
    // element can come out a microsecond short of the frame it belongs to.
    const target = t + 0.0005;
    if (target < times[0]) return 0;
    let lo = 0;
    let hi = this.count - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (times[mid] <= target) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  /** A time inside frame `i`, safely clear of both its edges, for seeking. */
  seekTime(i) {
    const k = Math.max(0, Math.min(this.count - 1, i));
    return this.times[k] + Math.min(this.durations[k] * 0.5, 0.02);
  }

  /**
   * The timecode of frame `i`: hours, minutes, seconds and the frame within
   * that second, counted from the frames that really are in that second —
   * so it is exact on variable-frame-rate video too, where frames-per-second
   * arithmetic drifts.
   */
  timecode(i) {
    const k = Math.max(0, Math.min(this.count - 1, i));
    const t = Math.max(0, this.times[k]);
    const whole = Math.floor(t + 1e-6);
    const first = this.firstIndexFrom(whole);
    const ff = k - first;
    const h = Math.floor(whole / 3600);
    const m = Math.floor((whole % 3600) / 60);
    const s = whole % 60;
    const pad = (n, w = 2) => String(n).padStart(w, '0');
    return `${pad(h)}:${pad(m)}:${pad(s)}:${pad(Math.max(0, ff))}`;
  }

  /** The first frame whose time is at or after `t`. */
  firstIndexFrom(t) {
    const times = this.times;
    let lo = 0;
    let hi = this.count;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (times[mid] < t - 1e-6) lo = mid + 1;
      else hi = mid;
    }
    return Math.min(lo, this.count - 1);
  }

  /**
   * Decode the given frames, in order, yielding each as a canvas holding the
   * whole picture at full size with rotation applied.
   *
   * The canvas is reused: each frame is only valid until the next is asked
   * for, so callers copy what they need (createImageBitmap) before moving on.
   * Every decoded frame is closed here as soon as it is drawn — decoded video
   * frames hold scarce decoder memory, and the decoder stalls when too many
   * are left for the garbage collector.
   *
   * @param {number[]} indices ascending frame indices
   */
  async *frames(indices, { signal = null } = {}) {
    if (!this.sink) this.sink = new VideoSampleSink(this.track);
    // The middle of each frame, never its start: the decoder's microsecond
    // timestamps can land a hair after the container's, and asking for the
    // exact start would then return the frame before.
    const stamps = indices.map((i) => this.seekTime(i));
    const canvas = new OffscreenCanvas(this.width, this.height);
    const ctx = canvas.getContext('2d');
    let k = 0;
    for await (const sample of this.sink.samplesAtTimestamps(stamps)) {
      if (!sample) throw new Error(`Frame ${indices[k]} could not be decoded.`);
      try {
        if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
        if (canvas.width !== sample.displayWidth || canvas.height !== sample.displayHeight) {
          canvas.width = sample.displayWidth;
          canvas.height = sample.displayHeight;
        }
        sample.drawWithFit(ctx, { fit: 'fill' });
      } finally {
        sample.close();
      }
      yield { index: indices[k], canvas };
      k++;
    }
  }

  dispose() {
    this.sink = null;
    try { this.input.dispose?.(); } catch { /* already gone */ }
  }
}
