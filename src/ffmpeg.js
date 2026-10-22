/**
 * The slow road: ffmpeg compiled to WebAssembly, for videos the browser
 * cannot decode itself — AVI, WMV, FLV, ProRes, H.265 on a machine without a
 * hardware decoder, and the rest of ffmpeg's very long list.
 *
 * Rather than a second way of doing everything, ffmpeg only ever turns the
 * file into something the fast road can take — an ordinary H.264 MP4 — and
 * the rest of the app works on that exactly as it would on any other video:
 *
 *  - a *proxy* of the whole video, small and quick to make, which the player
 *    plays and whose frame times stand in for the original's; and
 *  - when frames are converted, a *clip* of just the marked range at full
 *    size and near-lossless quality, which the GIF is made from.
 *
 * Both keep every frame's original timing (-fps_mode passthrough), so frame
 * k of the clip is frame (first + k) of the proxy, and the timecodes agree.
 *
 * ffmpeg.wasm runs single-threaded here. The multi-threaded build needs
 * SharedArrayBuffer, which needs COOP/COEP headers GitHub Pages cannot send.
 * The 32 MB core is downloaded the first time it is needed, from this site,
 * and the browser keeps it after that.
 */

import { FFmpeg } from '../vendor/ffmpeg/index.js';

const CORE_URL = new URL('../vendor/ffmpeg-core/ffmpeg-core.js', import.meta.url).href;
const WASM_URL = new URL('../vendor/ffmpeg-core/ffmpeg-core.wasm', import.meta.url).href;
const WASM_BYTES = 32232419;     // for the download bar when the server sends no length

export const available = typeof WebAssembly === 'object';

let ff = null;
let wasmBlobUrl = null;
let mounted = null;              // the File currently visible at /in
const log = [];

/** Fetch the core with a progress bar, once; later loads reuse the copy. */
async function fetchWasm(onProgress, signal) {
  if (wasmBlobUrl) return wasmBlobUrl;
  const response = await fetch(WASM_URL, { signal });
  if (!response.ok) throw new Error(`Could not download ffmpeg (${response.status}).`);
  const total = +response.headers.get('content-length') || WASM_BYTES;
  const reader = response.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    onProgress?.(Math.min(1, got / total));
  }
  wasmBlobUrl = URL.createObjectURL(new Blob(chunks, { type: 'application/wasm' }));
  return wasmBlobUrl;
}

/** Start ffmpeg if it is not running. */
export async function load({ onProgress = null, signal = null } = {}) {
  if (ff) return ff;
  const wasmURL = await fetchWasm(onProgress, signal);
  const instance = new FFmpeg();
  instance.on('log', ({ message }) => {
    log.push(message);
    if (log.length > 60) log.shift();
  });
  await instance.load({ coreURL: CORE_URL, wasmURL }, { signal });
  ff = instance;
  mounted = null;
  return ff;
}

/** Stop whatever ffmpeg is doing. The next call starts it afresh. */
export function stop() {
  if (!ff) return;
  try { ff.terminate(); } catch { /* already stopped */ }
  ff = null;
  mounted = null;
}

/**
 * Make `file` readable at /in/<name> without copying it into ffmpeg's
 * memory: WORKERFS reads straight from the File, so a 2 GB video costs
 * nothing until ffmpeg reads it.
 */
async function mount(file) {
  if (mounted === file) return `/in/${file.name}`;
  if (mounted) {
    try { await ff.unmount('/in'); } catch { /* nothing mounted */ }
  } else {
    try { await ff.createDir('/in'); } catch { /* already there */ }
  }
  await ff.mount('WORKERFS', { files: [file] }, '/in');
  mounted = file;
  return `/in/${file.name}`;
}

/** Run ffmpeg, reporting progress as a fraction of `expectedSeconds`. */
async function run(args, { expectedSeconds = 0, onProgress = null, signal = null } = {}) {
  log.length = 0;
  const progress = ({ time }) => {
    // `time` is microseconds of output written.
    if (onProgress && expectedSeconds > 0 && time > 0) {
      onProgress(Math.min(1, time / 1e6 / expectedSeconds));
    }
  };
  ff.on('progress', progress);
  const abort = () => stop();
  signal?.addEventListener('abort', abort);
  try {
    const code = await ff.exec(args);
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    if (code !== 0) {
      const detail = log.filter((l) => /error|invalid|unknown|not|fail/i.test(l)).slice(-3).join(' · ');
      throw new Error(`ffmpeg could not convert this file${detail ? `: ${detail}` : '.'}`);
    }
  } catch (err) {
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    throw err;
  } finally {
    ff?.off('progress', progress);
    signal?.removeEventListener('abort', abort);
  }
}

async function take(path) {
  const data = await ff.readFile(path);
  try { await ff.deleteFile(path); } catch { /* gone already */ }
  return new Blob([data], { type: 'video/mp4' });
}

/**
 * The duration in seconds, from ffmpeg's own report of the input, for the
 * proxy's progress bar. 0 when it cannot tell.
 */
function durationFromLog() {
  for (const line of log) {
    const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(line);
    if (m) return +m[1] * 3600 + +m[2] * 60 + +m[3];
  }
  return 0;
}

/**
 * What ffmpeg says the original video is — codec and size — from its report
 * of the input, so the app can describe the file rather than the proxy.
 */
function streamFromLog() {
  for (const line of log) {
    const m = /Stream #\d+:\d+.*?: Video: (\w+).*?, (\d{2,5})x(\d{2,5})/.exec(line);
    if (m) return { codec: m[1], width: +m[2], height: +m[3] };
  }
  return null;
}

/**
 * A small, quick copy of the whole video for the player: at most 540 px
 * tall, a keyframe every half second so seeking is instant, and the sound.
 * Returns `{ blob, original }`, where `original` is ffmpeg's description of
 * the input's video stream, or null.
 */
export async function makeProxy(file, { onProgress = null, signal = null } = {}) {
  await load({ signal });
  const input = await mount(file);
  // A dry run to read the duration, so the bar can move. ffmpeg with no
  // output exits with an error by design, after printing what it found.
  try { await ff.exec(['-hide_banner', '-i', input]); } catch { /* expected */ }
  const seconds = durationFromLog();
  const original = streamFromLog();
  await run([
    '-hide_banner', '-i', input,
    '-map', '0:v:0', '-map', '0:a:0?',
    '-vf', "scale=w=-2:h='min(540,ih)':flags=bilinear",
    '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'fastdecode', '-crf', '26',
    '-g', '15', '-pix_fmt', 'yuv420p', '-fps_mode', 'passthrough',
    '-c:a', 'aac', '-b:a', '96k', '-ac', '2',
    '-movflags', '+faststart', '/proxy.mp4',
  ], { expectedSeconds: seconds, onProgress, signal });
  return { blob: await take('/proxy.mp4'), original };
}

/**
 * The marked frames at full size and near-lossless quality: `count` frames
 * starting with the one shown at `startTime` seconds.
 *
 * The seek goes half a frame early: ffmpeg decodes from the keyframe before
 * and drops everything earlier than the asked-for time, so starting inside
 * the frame before would include it, and starting on the exact edge could
 * fall either way.
 */
export async function makeClip(file, { startTime, frameDuration, count, onProgress = null, signal = null }) {
  await load({ signal });
  const input = await mount(file);
  const seek = Math.max(0, startTime - frameDuration / 2);
  await run([
    '-hide_banner', '-ss', seek.toFixed(6), '-i', input,
    '-map', '0:v:0', '-frames:v', String(count),
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '8', '-g', '30',
    '-pix_fmt', 'yuv420p', '-fps_mode', 'passthrough', '-an', '/clip.mp4',
  ], { expectedSeconds: count * frameDuration, onProgress, signal });
  return take('/clip.mp4');
}
