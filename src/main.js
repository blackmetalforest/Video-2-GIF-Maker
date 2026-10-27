/**
 * Video 2 GIF Maker — the app.
 *
 * The flow, top to bottom of the screen:
 *
 *  1. A video is chosen. Its frames are indexed (src/source.js) and it plays
 *     in the player (src/player.js). A file the browser cannot decode goes
 *     through ffmpeg first (src/ffmpeg.js).
 *  2. The start and end are marked on the video.
 *  3. A frame size, a convert skip and a quality are chosen, and Convert to
 *     Frames decodes the marked frames, plus three either side, into compressed
 *     stills (src/frame-store.js) shown in the filmstrip (src/filmstrip.js).
 *     If they would need more memory than a tab can comfortably hold, a dialog
 *     suggests smaller sizes first.
 *  4. The GIF's first and last frame are picked there, and the settings —
 *     frame skip, size, crop, colours, captions — shape it. The GIF view
 *     shows the result, and Preview plays it at its real timing.
 *  5. Save draws every kept frame from those converted frames — cropped,
 *     captioned, at the GIF's size — and encodes it (src/encoders/).
 */

import { openVideo, NotDecodable, formatFps } from './source.js';
import { Player } from './player.js';
import { Filmstrip } from './filmstrip.js';
import { CropTool } from './crop.js';
import {
  clampCrop, centredCrop, sizeForLongSide, captionLayer, drawFrame, scaleCrop,
} from './compose.js';
import { isBlank } from './overlay-text.js';
import {
  keptFrames, summarise, frameStarts, frameIndexAt, FPS_LIMIT,
} from './encoders/timing.js';
import { encodeGif } from './encoders/gif.js';
import { encodeStill, muxAnimationParts } from './encoders/webp.js';
import { encodePng } from './encoders/png.js';
import { zipWriter, frameName } from './encoders/frames.js';
import { FrameStore } from './frame-store.js';
import { maybeYield } from './yield.js';
import * as ffmpeg from './ffmpeg.js';

const $ = (id) => document.getElementById(id);

/** Extra frames taken either side of the marks, against off-by-one slips. */
const PAD = 3;
/** Past this many frames a warning, because the GIF will be enormous. */
const FRAMES_HEAVY = 450;

/*
 * Converted frames are kept as compressed WebP stills (src/frame-store.js),
 * so their memory is an estimate made before converting: pixels times a
 * typical number of bytes per pixel for the quality chosen, checked against
 * the real figure once the first frames are in. There is no cap on the
 * number of frames — only on memory.
 *
 * STORE_COMFORT is what the browser's blob store holds without trouble; it
 * can spill to disk, so this is more than a tab's own memory. Past it Convert
 * asks first, suggesting smaller sizes or more skip. STORE_HARD is past
 * anything likely to work, where only smaller choices are offered.
 */
const GB = 1024 ** 3;
const STORE_COMFORT = 3 * GB;
const STORE_HARD = 16 * GB;
/** Typical WebP bytes per pixel of video, by quality; a starting estimate. */
const BYTES_PER_PIXEL = { 1: 1.6, 0.9: 0.32, 0.75: 0.17, 0.5: 0.1 };
/** Each still's own overhead: its headers and the blob store's bookkeeping. */
const BYTES_PER_FRAME = 600;
/** Converted frames kept on their way to the encoder at once. */
const ENCODES_IN_FLIGHT = 6;
/** Frame sizes offered, by long side, when smaller than the video's own. */
const FRAME_SIDES = [3840, 2560, 1920, 1440, 1280, 960, 720, 640, 480, 360, 240];

const FORMAT_LABELS = { gif: 'GIF', webp: 'WebP', zip: 'ZIP' };

/* ------------------------------------------------------------------ state */

let file = null;             // the File chosen, or the address of one (?src=)
let baseName = 'clip';       // its name without the extension
let source = null;           // VideoSource the player and timecodes use
let mode = 'native';         // 'native' | 'ffmpeg'
let original = null;         // ffmpeg's { codec, width, height } of a converted file
let loadToken = 0;           // bumps on every new file, so stale work can tell
let clip = null;             // the converted frames; see convert()
let sel = { start: 0, end: 0 };
let crop = null;             // { x, y, w, h } in video pixels
let converting = null;       // AbortController while converting
let saving = null;           // AbortController while saving
let webpSupported = true;

const player = new Player({
  video: $('video'),
  scrub: $('scrub'),
  head: $('scrub-head'),
  clip: $('scrub-clip'),
  markIn: $('scrub-in'),
  markOut: $('scrub-out'),
});
const strip = new Filmstrip($('strip'));
const cropTool = new CropTool($('crop-layer'), $('crop-box'));
const gifCanvas = $('gif-canvas');
const gifCtx = gifCanvas.getContext('2d');

/* ---------------------------------------------------------------- helpers */

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

function setBusy(text) {
  if (text) { $('busy-text').textContent = text; $('busy').hidden = false; }
  else $('busy').hidden = true;
}

function setProgress(id, fraction) {
  // The Convert button under the video has no bar of its own: it counts.
  if (id === 'convert-progress') {
    $('convert-here').textContent = fraction === null || fraction >= 1
      ? 'Convert to Frames' : `Converting… ${Math.round(fraction * 100)}%`;
  }
  const wrap = $(`${id}-wrap`);
  if (fraction === null || fraction >= 1) { wrap.hidden = true; return; }
  wrap.hidden = false;
  $(id).style.width = `${Math.max(0, fraction) * 100}%`;
}

/** Seconds as people read them: 4.20 s, 1:04.2 past a minute, 2:06:46.8 past an hour. */
function seconds(s) {
  if (s < 60) return `${s.toFixed(2)} s`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = (s % 60).toFixed(1).padStart(4, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${rest}` : `${m}:${rest}`;
}

function duration(s) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
    : `${m}:${String(sec).padStart(2, '0')}`;
}

/** A file size: KB up to 1024 KB, MB above, in red past the Discord line. */
const BIG_FILE_MB = 9.9;
function fileSizeHtml(bytes) {
  const kb = bytes / 1024;
  if (kb <= 1024) return `${kb.toFixed(0)} KB`;
  const mb = (kb / 1024).toFixed(2);
  return +mb >= BIG_FILE_MB ? `<strong class="warn">${mb} MB</strong>` : `${mb} MB`;
}

/**
 * An error, worded for the person reading it. Running out of memory arrives
 * as a RangeError nobody should have to decode, and has one useful answer.
 */
function friendlyError(err) {
  const message = err?.message ?? String(err);
  if (err instanceof RangeError || /allocation failed|out of memory/i.test(message)) {
    return `Ran out of memory (${message}). Try a shorter clip, more frame skip or a smaller size.`;
  }
  return message;
}

function isAbort(err) { return err?.name === 'AbortError'; }

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/** A timecode safe for a file name: 00-01-23-14. */
function fileTimecode(tc) { return tc.replace(/:/g, '-'); }

/* ------------------------------------------------------------ choosing */

$('browse').addEventListener('click', () => $('file-input').click());
$('browse-empty').addEventListener('click', () => $('file-input').click());
$('file-name').addEventListener('click', () => $('file-input').click());
$('file-input').addEventListener('change', (e) => {
  const chosen = e.target.files?.[0];
  if (chosen) handleFile(chosen);
  e.target.value = '';      // so choosing the same file again still fires
});

// Dropping a file anywhere on the page.
let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  if (!e.dataTransfer?.types?.includes('Files')) return;
  dragDepth++;
  $('app').classList.add('dragover');
});
window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) $('app').classList.remove('dragover');
});
// Only a file being dragged in is welcome. Anything else — a text selection
// picked up by accident — gets no drop cursor and no drop.
window.addEventListener('dragover', (e) => {
  if (e.dataTransfer?.types?.includes('Files')) e.preventDefault();
});
// Nothing in the app is meant to be dragged out of it.
document.addEventListener('dragstart', (e) => {
  if (e.target.closest?.('#work')) e.preventDefault();
});
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('app').classList.remove('dragover');
  const dropped = e.dataTransfer?.files?.[0];
  if (dropped) handleFile(dropped);
});

/**
 * Open a video: index it, play it, and get the marks ready. A file the
 * browser cannot take is not an error yet — it is an offer to convert it.
 */
async function handleFile(chosen) {
  const token = ++loadToken;
  stopEverything();
  file = chosen;
  original = null;
  // An address (the ?src= route) is named after its last part.
  const name = typeof chosen === 'string'
    ? decodeURIComponent(chosen.split(/[?#]/)[0].split('/').pop() || 'video')
    : chosen.name;
  baseName = name.replace(/\.[^.]+$/, '') || 'clip';
  $('file-name').value = name;
  $('file-name').title = name;   // the whole name, however narrow the box
  mode = 'native';
  resetVideoState();
  $('video-info').textContent = 'Reading the video…';
  setBusy('Reading the video…');

  try {
    const opened = await openVideo(chosen, {
      onProgress: (f) => { if (token === loadToken) setBusy(`Indexing frames… ${Math.round(f * 100)}%`); },
    });
    if (token !== loadToken) { opened.dispose(); return; }
    try {
      await player.load(chosen, opened);
    } catch (err) {
      opened.dispose();
      throw new NotDecodable(err.message, { reason: 'player', codec: opened.codec, container: opened.container });
    }
    if (token !== loadToken) return;
    source = opened;
    videoReady();
  } catch (err) {
    if (token !== loadToken) return;
    setBusy('');
    if (err instanceof NotDecodable) offerFallback(err);
    else {
      console.error(err);
      $('video-info').innerHTML = `<span class="warn">${escapeHtml(friendlyError(err))}</span>`;
    }
  }
}

/** Forget the last video entirely. */
function resetVideoState() {
  player.unload();
  source?.dispose();
  source = null;
  discardClip();
  $('video').hidden = true;
  $('dropzone').hidden = true;
  $('fallback-row').hidden = true;
  $('save-info').textContent = '';
  setTransportEnabled(false);
  $('frame-size').disabled = true;
  $('convert-skip').disabled = true;
  syncMarks();
  if (window.Preflight) window.Preflight.extras = { ...window.Preflight.extras, video: null };
}

/** Cancel anything in flight: conversion, saving, ffmpeg. */
function stopEverything() {
  converting?.abort();
  saving?.abort();
  fallbackAbort?.abort();
}

function videoReady() {
  setBusy('');
  $('video').hidden = false;
  $('dropzone').hidden = true;
  setTransportEnabled(true);
  const s = source;
  // A converted file is described as it really is, not as its proxy.
  const real = mode === 'ffmpeg' && original;
  const bits = [
    real ? `${original.width}×${original.height}` : `${s.width}×${s.height}`,
    real ? original.codec.toUpperCase() : s.codec,
    real ? file.name.split('.').pop().toUpperCase() : s.container,
    `${s.variable ? '~' : ''}${formatFps(s.fps)} fps`,
    duration(s.duration),
    `${s.count.toLocaleString()} frames`,
  ];
  if (mode === 'ffmpeg') bits.push(`playing a ${s.height}p copy made by ffmpeg`);
  $('video-info').textContent = bits.join(' · ');
  $('video-info').title = s.variable
    ? 'Variable frame rate: frames are not evenly spaced. Timecodes count the real frames.'
    : '';
  if (window.Preflight) {
    window.Preflight.extras = { ...window.Preflight.extras, video: bits.join(' · ') };
  }
  // The whole video is marked to begin with, so a short clip can be
  // converted straight away and a long one only needs its marks moved in.
  player.setMark('in', 0);
  player.setMark('out', s.count - 1);
  fillFrameSizes();
  syncMarks();
  updateFrameReadout();
  $('scrub').focus({ preventScroll: true });
}

function setTransportEnabled(on) {
  for (const id of ['play', 'step-back', 'step-fwd', 'mark-in', 'mark-out', 'mute']) {
    $(id).disabled = !on;
  }
  syncMarks();
}

/* ---------------------------------------------------- the ffmpeg road */

let fallbackAbort = null;
let fallbackReason = null;

/** Explain why the file needs ffmpeg, and offer it. */
function offerFallback(err) {
  fallbackReason = err;
  $('dropzone').hidden = false;
  $('video').hidden = true;
  const what = err.reason === 'container'
    ? 'The browser cannot open this kind of file.'
    : err.reason === 'codec' ? `This browser has no decoder for ${err.codec} video.`
      : err.reason === 'player' ? `This browser cannot play this ${err.codec ?? ''} video.`
        : err.reason === 'decode' ? `The browser’s decoder failed on this video (${err.message}).`
          : err.message;
  $('video-info').innerHTML = `<span class="caution">${escapeHtml(what)}</span>`;
  if (err.reason === 'no-video') { $('fallback-row').hidden = true; return; }
  if (typeof file === 'string') {
    // ffmpeg reads a File; an address cannot be handed to it.
    $('video-info').innerHTML += ' <span class="muted">Choose the file itself to convert it with ffmpeg.</span>';
    $('fallback-row').hidden = true;
    return;
  }
  if (!ffmpeg.available) {
    $('video-info').innerHTML += ' <span class="muted">This browser cannot run ffmpeg either (no WebAssembly).</span>';
    return;
  }
  $('fallback-note').innerHTML =
    'It can be converted with <strong>ffmpeg</strong>, here in the page. ' +
    'The first time, that downloads 32 MB. Converting is slow: roughly as long as the video plays, often more.';
  $('fallback-row').hidden = false;
  $('fallback-go').disabled = false;
  $('fallback-cancel').disabled = true;
}

$('fallback-go').addEventListener('click', () => startFallback());
$('fallback-cancel').addEventListener('click', () => fallbackAbort?.abort());

/** Make the proxy, then carry on as if the proxy were the video. */
async function startFallback() {
  if (!file) return;
  const token = loadToken;
  fallbackAbort = new AbortController();
  const { signal } = fallbackAbort;
  $('fallback-go').disabled = true;
  $('fallback-cancel').disabled = false;
  player.unload();
  source?.dispose();
  source = null;
  discardClip();
  try {
    setBusy('Downloading ffmpeg…');
    await ffmpeg.load({
      signal,
      onProgress: (f) => setBusy(`Downloading ffmpeg… ${Math.round(f * 100)}%`),
    });
    setBusy('Converting the video for playback… 0%');
    const { blob: proxy, original: described } = await ffmpeg.makeProxy(file, {
      signal,
      onProgress: (f) => setBusy(`Converting the video for playback… ${Math.round(f * 100)}%`),
    });
    if (token !== loadToken) return;
    setBusy('Indexing frames…');
    const opened = await openVideo(proxy);
    await player.load(proxy, opened);
    if (token !== loadToken) { opened.dispose(); return; }
    source = opened;
    mode = 'ffmpeg';
    original = described;
    $('fallback-row').hidden = true;
    videoReady();
  } catch (err) {
    setBusy('');
    if (token !== loadToken) return;
    $('fallback-go').disabled = false;
    $('fallback-cancel').disabled = true;
    if (isAbort(err)) {
      $('fallback-note').textContent = 'Stopped. Convert with ffmpeg to try again.';
      return;
    }
    console.error(err);
    $('fallback-note').innerHTML = `<span class="warn">${escapeHtml(friendlyError(err))}</span>`;
  } finally {
    fallbackAbort = null;
  }
}

/* ------------------------------------------------------- the player UI */

player.addEventListener('frame', updateFrameReadout);
player.addEventListener('state', () => {
  $('play').textContent = player.playing ? '❚❚' : '▶︎';
  $('mute').textContent = $('video').muted ? '🔇' : '🔊';
});
player.addEventListener('marks', syncMarks);

function updateFrameReadout() {
  if (!source) { $('timecode').value = '00:00:00:00'; $('frame-number').textContent = ''; return; }
  $('timecode').value = source.timecode(player.frame);
  $('frame-number').textContent = `frame ${player.frame.toLocaleString()}`;
}

$('play').addEventListener('click', () => player.togglePlay());
$('step-back').addEventListener('click', (e) => (e.shiftKey ? player.stepSeconds(-1) : player.step(-1)));
$('step-fwd').addEventListener('click', (e) => (e.shiftKey ? player.stepSeconds(1) : player.step(1)));
$('mark-in').addEventListener('click', () => markHere('in'));
$('mark-out').addEventListener('click', () => markHere('out'));
$('jump-in').addEventListener('click', () => jumpToMark('in'));
$('jump-out').addEventListener('click', () => jumpToMark('out'));
$('in-jump').addEventListener('click', () => jumpToMark('in'));
$('out-jump').addEventListener('click', () => jumpToMark('out'));
$('mute').addEventListener('click', () => { $('video').muted = !$('video').muted; });

/**
 * Mark the frame on screen. While playing, that is the frame being shown at
 * the moment of the click — which the frame callback knows exactly — and the
 * video pauses there, so the mark can be checked and nudged.
 */
function markHere(which) {
  if (!source) return;
  if (player.playing) $('video').pause();
  player.setMark(which, player.frame);
}

function jumpToMark(which) {
  const k = player.marks[which];
  if (k !== null && source) player.seekFrame(k);
}

/** Everything that shows the marks: sidebar, transport, Convert. */
function syncMarks() {
  const { in: a, out: b } = player.marks;
  const has = !!source;
  $('in-jump').textContent = has && a !== null ? source.timecode(a) : '—';
  $('out-jump').textContent = has && b !== null ? source.timecode(b) : '—';
  $('in-jump').disabled = !has || a === null;
  $('out-jump').disabled = !has || b === null;
  $('jump-in').disabled = !has || a === null;
  $('jump-out').disabled = !has || b === null;

  const ready = has && a !== null && b !== null;
  setConvertEnabled(ready && !converting);
  if (!has) $('clip-info').textContent = '—';
  else if (!ready) {
    $('clip-info').textContent = a === null && b === null
      ? 'No marks yet.'
      : a === null ? 'Now mark the start.' : 'Now mark the end.';
  } else {
    const frames = b - a + 1;
    const length = source.times[b] + source.durations[b] - source.times[a];
    let html = `${frames.toLocaleString()} frames · ${seconds(length)}`;
    if (frames > FRAMES_HEAVY) html += ' · <span class="caution">long: a big GIF</span>';
    $('clip-info').innerHTML = html;
  }
  updateMemoryInfo();
}

/* -------------------------------------------------------------- convert */

$('convert').addEventListener('click', () => requestConvert());
$('convert-here').addEventListener('click', () => requestConvert());

/** Both Convert to Frames buttons, the Clip section's and the one under the video. */
function setConvertEnabled(on) {
  $('convert').disabled = !on;
  $('convert-here').disabled = !on;
}
$('convert-cancel').addEventListener('click', () => converting?.abort());

function discardClip() {
  stopPreview();
  clip?.store.dispose();
  clip = null;
  strip.clear();
  cropTool.hide();
  $('crop-edit').checked = false;
  $('gif-canvas').hidden = true;
  $('gif-placeholder').hidden = false;
  $('preview-mirror').checked = false;
  $('strip-info').textContent = 'No frames yet.';
  $('view-size').textContent = '';
  setGifTransportEnabled(false);
  $('gif-frame-number').value = 'frame —';
  setSaveEnabled(false);
  $('output-info').textContent = 'Convert to Frames first.';
  $('frames-info').textContent = '—';
}

/* ------------------------------------------------------------ frame size */

/** The video's own frame size: the original's, even when a proxy is playing. */
function baseSize() {
  if (mode === 'ffmpeg' && original) return { w: original.width, h: original.height };
  return { w: source.width, h: source.height };
}

/** Frames whose long side is `side` (0 for the video's own), keeping the shape. */
function dimsFor(side) {
  const { w, h } = baseSize();
  const long = Math.max(w, h);
  if (!(side > 0) || side >= long) return { w, h };
  const k = side / long;
  return { w: Math.max(2, Math.round(w * k)), h: Math.max(2, Math.round(h * k)) };
}

/** The Frame size menu, for this video: its own size, then smaller ones. */
function fillFrameSizes() {
  const select = $('frame-size');
  const { w, h } = baseSize();
  const long = Math.max(w, h);
  const options = [`<option value="0">Original — ${w} × ${h}</option>`];
  for (const side of FRAME_SIDES) {
    if (side >= long) continue;
    const d = dimsFor(side);
    options.push(`<option value="${side}">${d.w} × ${d.h}</option>`);
  }
  options.push('<option value="custom">Custom…</option>');
  select.innerHTML = options.join('');
  select.value = '0';
  select.disabled = false;
  $('frame-size-custom').max = String(long);
  $('frame-size-custom').value = String(Math.min(720, long));
  $('frame-size-custom-row').hidden = true;

  // Convert skip, labelled with the frame rate each leaves.
  const fps = source.fps;
  const skips = [];
  for (let n = 0; n <= 29; n++) {
    if (n > 15 && n % 5 !== 4) continue;
    const rate = fps / (n + 1);
    const label = n === 0 ? `None — every frame (${formatFps(fps)} fps)`
      : `${n} — every ${ordinal(n + 1)} frame (${rate >= 10 ? rate.toFixed(0) : rate.toFixed(1)} fps)`;
    skips.push(`<option value="${n}">${label}</option>`);
  }
  $('convert-skip').innerHTML = skips.join('');
  $('convert-skip').value = '0';
  $('convert-skip').disabled = false;
}

/** The long side chosen, in pixels; 0 is the video's own size. */
function chosenSide() {
  const v = $('frame-size').value;
  if (v !== 'custom') return +v;
  const long = Math.max(baseSize().w, baseSize().h);
  return Math.max(16, Math.min(long, Math.round(+$('frame-size-custom').value) || long));
}

/** One frame in every `step` is converted. */
const chosenStep = () => +$('convert-skip').value + 1;
const chosenQuality = () => +$('frame-quality').value;

/**
 * The frames Convert takes, as indices into the video: every `step`th frame,
 * lined up so the start mark is one of them, with PAD more either side.
 */
function convertPlan(step = chosenStep()) {
  const { in: a, out: b } = player.marks;
  if (!source || a === null || b === null) return null;
  const before = Math.min(PAD, Math.floor(a / step));
  const first = a - before * step;
  const lastMarked = a + Math.floor((b - a) / step) * step;
  const after = Math.min(PAD, Math.floor((source.count - 1 - lastMarked) / step));
  const last = lastMarked + after * step;
  const count = (last - first) / step + 1;
  return { first, last, step, count, padBefore: before, padAfter: after };
}

/** How many frames Convert would decode: the marked ones and the padding. */
function framesToConvert() { return convertPlan()?.count ?? 0; }

/** Stored size of `count` frames of `d` at `quality`: an estimate. */
const bytesFor = (count, d, quality = chosenQuality()) =>
  count * (d.w * d.h * (BYTES_PER_PIXEL[quality] ?? 0.32) + BYTES_PER_FRAME);

function formatBytes(bytes) {
  return bytes >= GB ? `${(bytes / GB).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
}

/** The estimate under Frame size, warned in orange past the comfortable. */
function updateMemoryInfo() {
  const count = framesToConvert();
  if (!count) { $('memory-info').textContent = '—'; return; }
  const d = dimsFor(chosenSide());
  const bytes = bytesFor(count, d);
  let html = `${count.toLocaleString()} frames at ${d.w} × ${d.h} ≈ ${formatBytes(bytes)}`;
  if (bytes > STORE_COMFORT) html = `<span class="caution">${html} — more than a browser tab usually manages</span>`;
  if (clip && (clip.workW !== d.w || clip.workH !== d.h || clip.step !== chosenStep())) {
    html += `<br>The frames now are ${clip.workW} × ${clip.workH}` +
      (clip.step > 1 ? `, every ${ordinal(clip.step)}` : '') + '. Convert again to change them.';
  }
  $('memory-info').innerHTML = html;
}

$('frame-size').addEventListener('input', () => {
  $('frame-size-custom-row').hidden = $('frame-size').value !== 'custom';
  updateMemoryInfo();
});
for (const id of ['frame-size-custom', 'convert-skip', 'frame-quality']) {
  $(id).addEventListener('input', updateMemoryInfo);
}

/**
 * Convert, unless the frames would need more memory than is comfortable — then
 * ask first, offering the largest sizes that fit.
 */
function requestConvert() {
  if (!source || converting) return;
  const count = framesToConvert();
  if (!count) return;
  const side = chosenSide();
  const bytes = bytesFor(count, dimsFor(side));
  if (bytes <= STORE_COMFORT) { convert(side); return; }
  showMemoryDialog(count, side, bytes);
}

const memoryDialog = document.createElement('div');
memoryDialog.className = 'sheet';
memoryDialog.hidden = true;
document.body.append(memoryDialog);
memoryDialog.addEventListener('click', (e) => { if (e.target === memoryDialog) memoryDialog.hidden = true; });

function showMemoryDialog(count, side, bytes) {
  const d = dimsFor(side);
  // Every size on offer, largest first; the ones that fit are suggested.
  const sides = [0, ...FRAME_SIDES].filter((s, i, all) => {
    const dims = dimsFor(s);
    return all.findIndex((t) => dimsFor(t).w === dims.w) === i && dims.w <= d.w && s !== side;
  });
  let fits = sides.filter((s) => bytesFor(count, dimsFor(s)) <= STORE_COMFORT).slice(0, 3);
  if (!fits.length) fits = sides.filter((s) => bytesFor(count, dimsFor(s)) <= STORE_HARD).slice(-2);
  const button = (s, primary) => {
    const dims = dimsFor(s);
    return `<button type="button" class="${primary ? 'primary' : ''}" data-side="${s}">` +
      `Convert at ${dims.w} × ${dims.h} <span class="dim">· ${formatBytes(bytesFor(count, dimsFor(s)))}</span></button>`;
  };
  const anyway = bytes <= STORE_HARD
    ? `<button type="button" data-side="${side}" data-anyway="1">Convert anyway at ${d.w} × ${d.h}</button>` : '';
  memoryDialog.innerHTML = `
    <div class="sheet-card memory-card" role="dialog" aria-modal="true" aria-labelledby="memory-title">
      <h2 id="memory-title">That needs a lot of memory</h2>
      <p>Converting <strong>${count.toLocaleString()} frames</strong> at <strong>${d.w} × ${d.h}</strong>
        needs about <strong>${formatBytes(bytes)}</strong>. A browser tab usually manages about
        ${formatBytes(STORE_COMFORT)} before it slows down or crashes.</p>
      <p class="muted small">A smaller frame size or lower quality keeps the whole clip. More Convert
        skip keeps fewer frames. A shorter clip — moving Start or End in — keeps the full size.
        ${fits.length ? '' : ' Even the smallest size is too big for this clip: skip more frames or shorten it.'}</p>
      <div class="memory-choices">
        ${fits.map((s, i) => button(s, i === 0)).join('')}
        ${anyway}
        <button type="button" data-cancel="1">Cancel</button>
      </div>
    </div>`;
  memoryDialog.hidden = false;
  memoryDialog.querySelector('button')?.focus();
  memoryDialog.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
    memoryDialog.hidden = true;
    if (b.dataset.cancel) return;
    const chosen = +b.dataset.side;
    // The menu follows the choice, so what was converted is what it shows.
    const option = [...$('frame-size').options].find((o) => +o.value === chosen);
    if (option) $('frame-size').value = option.value;
    else { $('frame-size').value = 'custom'; $('frame-size-custom').value = String(chosen); }
    $('frame-size-custom-row').hidden = $('frame-size').value !== 'custom';
    convert(chosen);
  }));
}

/**
 * Decode the marked frames, and PAD more either side, at the chosen frame
 * size, keeping one in every `step`, and store each as a compressed still.
 *
 * The decoder runs straight through the range (VideoSource.sequence); each
 * kept frame is drawn straight onto a canvas of the frame size — the graphics
 * card does the shrinking — and handed to the browser's WebP encoder, several
 * at once, while the next is decoded.
 */
async function convert(side = chosenSide()) {
  if (!source || converting) return;
  const range = convertPlan();
  if (!range) return;
  player.video.pause();

  const { first, last, step, count } = range;
  const token = loadToken;
  converting = new AbortController();
  const { signal } = converting;
  discardClip();
  setConvertEnabled(false);
  $('convert-cancel').disabled = false;
  $('convert-info').textContent = 'Decoding…';
  setProgress('convert-progress', 0);

  const sw = source.width;
  const sh = source.height;
  const { w: workW, h: workH } = dimsFor(side);
  const quality = chosenQuality();

  // The frames to be kept, and how long each stands for: until the next kept
  // one, or for its `step` frames at the end.
  const srcIndex = Array.from({ length: count }, (_, k) => first + k * step);
  const times = srcIndex.map((i) => source.times[i]);
  const durations = srcIndex.map((i, k) => {
    if (k + 1 < count) return times[k + 1] - times[k];
    const stop = Math.min(source.count - 1, i + step - 1);
    return source.times[stop] + source.durations[stop] - source.times[i];
  });
  const store = new FrameStore({ width: workW, height: workH });
  const next = {
    count, times, durations, srcIndex, step, quality, store,
    srcW: sw, srcH: sh, workW, workH, scale: workW / sw,
    padBefore: range.padBefore,
    padAfter: range.padAfter,
    label: (k) => srcIndex[k].toLocaleString(),
  };
  strip.reset(count, sw / sh, next.label, (k) => (store.blobs[k] ? store.get(k) : null));
  $('strip-info').textContent = 'Converting…';

  let decodeFrom = source;
  const started = performance.now();
  try {
    let from = first;
    let to = last;
    if (mode === 'ffmpeg') {
      // ffmpeg cuts the range out of the original at full size, and that cut
      // is what every frame comes from from now on.
      $('convert-info').textContent = 'Cutting the frames out with ffmpeg…';
      const cut = await ffmpeg.makeClip(file, {
        startTime: source.times[first],
        frameDuration: source.typicalStep,
        count: last - first + 1,
        signal,
        onProgress: (f) => setProgress('convert-progress', f * 0.5),
      });
      decodeFrom = await openVideo(cut);
      from = 0;
      to = Math.min(last - first, decodeFrom.count - 1);
      next.srcW = decodeFrom.width;
      next.srcH = decodeFrom.height;
      next.scale = workW / decodeFrom.width;
    }

    const canvas = new OffscreenCanvas(workW, workH);
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    const inflight = new Set();
    const base = mode === 'ffmpeg' ? 0.5 : 0;
    let k = 0;
    let shownAt = 0;
    for await (const { sample } of decodeFrom.sequence(from, to, step, { signal })) {
      try {
        sample.drawWithFit(ctx, { fit: 'fill' });
      } finally {
        sample.close();
      }
      // convertToBlob copies the canvas at once, so the canvas is free for
      // the next frame while this one encodes.
      const at = k;
      const job = canvas.convertToBlob({ type: 'image/webp', quality }).then((blob) => {
        store.set(at, blob);
        strip.draw(at);
      });
      inflight.add(job);
      job.finally(() => inflight.delete(job));
      if (inflight.size >= ENCODES_IN_FLIGHT) await Promise.race(inflight);
      k++;
      // Ten readouts a second is plenty.
      const now = performance.now();
      if (now - shownAt >= 100) {
        shownAt = now;
        const rate = k / ((now - started) / 1000);
        setProgress('convert-progress', base + (k / count) * (1 - base));
        $('convert-info').textContent = `Decoding… ${k.toLocaleString()} of ${count.toLocaleString()}` +
          ` · ${rate.toFixed(0)} fps · ${formatBytes(store.bytes)}`;
      }
      if (k >= count) break;
    }
    await Promise.all(inflight);
    if (token !== loadToken) { store.dispose(); return; }
    // Fewer frames than planned (a short ffmpeg cut, a truncated file): trim.
    if (k < count) {
      next.count = k;
      next.times.length = k;
      next.durations.length = k;
      next.srcIndex.length = k;
      next.padAfter = Math.max(0, next.padAfter - (count - k));
      strip.reset(k, sw / sh, next.label, (i) => (store.blobs[i] ? store.get(i) : null));
    }
    if (!next.count) throw new Error('No frames could be decoded.');
    clip = next;
    sel = { start: clip.padBefore, end: Math.max(clip.padBefore, clip.count - 1 - clip.padAfter) };
    const secs = (performance.now() - started) / 1000;
    $('convert-info').textContent =
      `${clip.count.toLocaleString()} frames at ${workW} × ${workH}` +
      (step > 1 ? `, every ${ordinal(step)}` : '') +
      ` · ${formatBytes(store.bytes)} · ${secs.toFixed(secs < 10 ? 1 : 0)} s` +
      ` · ${PAD} extra either side of the marks.`;
    clipReady();
  } catch (err) {
    store.dispose();
    strip.clear();
    if (isAbort(err)) {
      $('convert-info').textContent = 'Stopped.';
    } else if (mode === 'native' && /decod|codec|EncodingError|not supported/i.test(`${err?.name} ${err?.message}`)) {
      // The browser said it could decode this and then could not. ffmpeg can.
      console.error(err);
      $('convert-info').innerHTML = `<span class="warn">${escapeHtml(friendlyError(err))}</span>`;
      offerFallback(new NotDecodable(err.message, { reason: 'decode', codec: source?.codec }));
      $('video').hidden = false;
      $('dropzone').hidden = true;
    } else {
      console.error(err);
      $('convert-info').innerHTML = `<span class="warn">${escapeHtml(friendlyError(err))}</span>`;
    }
    $('strip-info').textContent = 'No frames yet.';
  } finally {
    // ffmpeg's cut has done its job once its frames are decoded.
    if (decodeFrom !== source) decodeFrom.dispose();
    converting = null;
    setProgress('convert-progress', null);
    $('convert-cancel').disabled = true;
    syncMarks();
  }
}

/** Frames are in: the GIF view, the strip and Save come alive. */
function clipReady() {
  if (!crop || crop.srcW !== clip.srcW || crop.srcH !== clip.srcH) resetCrop();
  $('gif-placeholder').hidden = true;
  $('gif-canvas').hidden = false;
  requestAnimationFrame(fitCanvas);
  setGifTransportEnabled(true);
  strip.select(sel.start, { scroll: false });
  strip.centre(sel.start);
  setSaveEnabled(true);
  refresh();
}

/* ------------------------------------------------------------ filmstrip */

strip.addEventListener('select', () => frameSelected());
strip.addEventListener('set', (e) => setEnd(e.detail.which));

/** A thumbnail was chosen: show it, and keep the video on the same frame. */
function frameSelected() {
  stopPreview();
  showSelected();
  if (clip && source && !player.playing) {
    const k = clip.srcIndex[strip.selected];
    if (k < source.count) player.seekFrame(k);
  }
}

/** Select a frame from the GIF bar's buttons. */
function selectFrame(k) {
  if (!clip) return;
  strip.select(k);
  frameSelected();
}

const GIF_TRANSPORT = ['gif-set-start', 'gif-set-end', 'gif-jump-start', 'gif-step-back',
  'gif-play', 'gif-step-fwd', 'gif-jump-end'];
function setGifTransportEnabled(on) {
  for (const id of GIF_TRANSPORT) $(id).disabled = !on;
}

$('gif-set-start').addEventListener('click', () => setEnd('start'));
$('gif-set-end').addEventListener('click', () => setEnd('end'));
$('gif-jump-start').addEventListener('click', () => selectFrame(sel.start));
$('gif-jump-end').addEventListener('click', () => selectFrame(sel.end));
$('gif-step-back').addEventListener('click', () => selectFrame(strip.selected - 1));
$('gif-step-fwd').addEventListener('click', () => selectFrame(strip.selected + 1));
$('gif-play').addEventListener('click', () => (previewing ? stopPreview() : startPreview()));

/** The GIF bar's reading: which video frame is on show. */
function showFrameNumber(k) {
  if (!clip) return;
  $('gif-frame-number').value = `frame ${clip.srcIndex[k].toLocaleString()}`;
}

/** Make the selected thumbnail the GIF's first or last frame. */
function setEnd(which) {
  if (!clip || strip.selected < 0) return;
  const k = strip.selected;
  if (which === 'start') sel = { start: k, end: Math.max(k, sel.end) };
  else sel = { start: Math.min(k, sel.start), end: k };
  refresh();
}

/* --------------------------------------------------------- the settings */

/** Frame skip and speed → which frames are kept, and for how long. */
function readTiming() {
  return keptFrames({
    times: clip.times,
    durations: clip.durations,
    start: sel.start,
    end: sel.end,
    skip: +$('skip').value,
    speed: +$('speed').value / 100,
  });
}

function readCaption() {
  const textMode = $('text-mode').value;
  if (textMode === 'off') return null;
  const style = {
    mode: textMode,
    family: $('text-font').value,
    weight: textMode === 'ontop' ? 0 : +$('text-stroke').value,
    scale: +$('text-size').value / 100,
  };
  if (textMode === 'ontop') {
    const band = $('text-band-copy').value;
    return band.trim() ? { ...style, band } : null;
  }
  const text = { top: $('text-top').value, middle: $('text-middle').value, bottom: $('text-bottom').value };
  return isBlank(text) ? null : { ...style, text };
}

/* ------------------------------------------------------------ the crop */

function cropAspect() {
  const v = $('crop-aspect').value;
  return v === 'off' || v === 'free' ? 0 : +v;
}

function resetCrop() {
  const w = clip?.srcW ?? source?.width ?? 1;
  const h = clip?.srcH ?? source?.height ?? 1;
  const aspect = $('crop-aspect').value === 'off' ? 0 : cropAspect();
  crop = { ...centredCrop(w, h, aspect), srcW: w, srcH: h };
}

$('crop-aspect').addEventListener('input', () => {
  const off = $('crop-aspect').value === 'off';
  $('crop-rows').hidden = off;
  resetCrop();
  // Choosing a shape is choosing to crop: show the box straight away.
  $('crop-edit').checked = !off && !!clip;
  refresh();
});
$('crop-edit').addEventListener('input', () => refresh());

cropTool.addEventListener('input', (e) => {
  crop = { ...e.detail, srcW: crop.srcW, srcH: crop.srcH };
  updateCropInfo();
  updateSizeReadouts();
});
cropTool.addEventListener('change', () => refresh());

function updateCropInfo() {
  if (!crop) { $('crop-info').textContent = '—'; return; }
  $('crop-info').textContent = `${crop.w} × ${crop.h} from ${crop.x}, ${crop.y}` +
    ($('crop-edit').checked ? ' — drag the box in the GIF view' : '');
}

/* ------------------------------------------------------------- the size */

/**
 * The GIF's size: the crop at the converted frames' scale, made smaller if
 * GIF size asks for it. Never larger — that would need new frames.
 */
function outputSize() {
  const c = scaleCrop(clampCrop(crop, clip.srcW, clip.srcH), clip.scale);
  const frame = { x: 0, y: 0, w: Math.max(2, Math.round(c.w)), h: Math.max(2, Math.round(c.h)) };
  return { ...sizeForLongSide(frame, +$('gif-size').value), frameW: frame.w, frameH: frame.h };
}

$('gif-size').addEventListener('input', () => refresh());

/* ---------------------------------------------------- refresh everything */

let plan = null;   // what the GIF is, worked out from every setting; see refresh()

/**
 * Work out the GIF from the settings, and show it everywhere: the strip's
 * markings, the readouts, the GIF view.
 */
function refresh() {
  syncReadouts();
  if (!clip) return;
  if (!crop) resetCrop();

  const { kept, idealMs } = readTiming();
  const gif = summarise(idealMs, 'gif');
  const caption = readCaption();
  const out = outputSize();
  const { layer, band } = captionLayer(caption, out.width, out.height);
  plan = {
    kept, idealMs, gif,
    width: out.width, height: out.height, band, layer,
    crop: clampCrop(crop, clip.srcW, clip.srcH),
  };

  strip.setState({
    start: sel.start, end: sel.end, kept: new Set(kept),
    padBefore: clip.padBefore, padAfter: clip.padAfter,
  });
  updateFramesInfo();
  updateCropInfo();
  updateSizeReadouts();
  rebuildPreviewCycle();
  showSelected();
}

function updateFramesInfo() {
  if (!plan) return;
  const { kept, gif } = plan;
  const tc = (k) => source?.timecode(Math.min(source.count - 1, clip.srcIndex[k])) ?? '';
  $('strip-info').innerHTML =
    `GIF: <strong>${tc(sel.start)}</strong> → <strong>${tc(sel.end)}</strong> · ` +
    `${(sel.end - sel.start + 1).toLocaleString()} frames, ${kept.length.toLocaleString()} kept`;
  let html = `${kept.length.toLocaleString()} frames · ${gif.fps.toFixed(gif.fps < 10 ? 1 : 0)} fps · ${seconds(gif.totalMs / 1000)}`;
  if (gif.slowed) {
    html += ` · <span class="caution">too fast for GIF players (max ${FPS_LIMIT} fps), so it plays slower — use Frame skip</span>`;
  }
  $('frames-info').innerHTML = html;
  $('output-info').innerHTML =
    `${plan.width} × ${plan.height + plan.band} px · ${kept.length.toLocaleString()} frames · ${seconds(gif.totalMs / 1000)}`;
}

function updateSizeReadouts() {
  if (!clip || !crop) { $('view-size').textContent = ''; $('size-info').textContent = '—'; return; }
  const out = outputSize();
  const band = plan?.band ?? 0;
  $('view-size').textContent = `${out.width} × ${out.height + band}`;
  $('size-info').textContent = `GIF: ${out.width} × ${out.height + band}` +
    (out.width < out.frameW ? ` (the cropped frames are ${out.frameW} × ${out.frameH})` : '');
}

/** The slider readings and notes that do not depend on frames. */
function syncReadouts() {
  const skip = +$('skip').value;
  $('skip-out').value = String(skip);
  $('skip-note').textContent = skip === 0 ? 'Every frame is kept.'
    : skip === 1 ? 'Every 2nd frame is kept, each shown twice as long.'
      : `Every ${ordinal(skip + 1)} frame is kept, each shown ${skip + 1}× as long.`;
  $('speed-out').value = `${(+$('speed').value).toLocaleString()}%`;
  $('colors-out').value = $('colors').value;
  $('webp-quality-out').value = $('webp-quality').value;
  $('webp-quality').disabled = $('webp-lossless').checked;
  $('text-stroke-out').value = (+$('text-stroke').value).toFixed(1);
  $('text-size-out').value = `${$('text-size').value}%`;
  const textMode = $('text-mode').value;
  $('text-blocks').hidden = textMode !== 'front';
  $('text-band').hidden = textMode !== 'ontop';
  $('text-style').hidden = textMode === 'off';
  $('text-stroke-row').hidden = textMode === 'ontop';
}

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

for (const id of ['skip', 'speed']) $(id).addEventListener('input', () => refresh());
for (const id of ['colors', 'webp-quality', 'webp-lossless', 'dither', 'size-limit']) {
  $(id).addEventListener('input', syncReadouts);
}
for (const id of ['text-mode', 'text-top', 'text-middle', 'text-bottom', 'text-band-copy',
  'text-font', 'text-stroke', 'text-size']) {
  $(id).addEventListener('input', () => refresh());
}
// A caption font arriving late changes how the text measures.
document.fonts?.addEventListener?.('loadingdone', () => { if (clip) refresh(); });
$('text-font').addEventListener('input', () => {
  document.fonts?.load(`40px ${$('text-font').value}`).then(() => refresh()).catch(() => {});
});

$('reset-frames').addEventListener('click', () => {
  $('skip').value = 0;
  setSliderValue('speed', 100);
  if (clip) sel = { start: clip.padBefore, end: Math.max(clip.padBefore, clip.count - 1 - clip.padAfter) };
  refresh();
});
$('reset-size').addEventListener('click', () => {
  $('gif-size').value = '0';
  $('crop-aspect').value = 'off';
  $('crop-rows').hidden = true;
  $('crop-edit').checked = false;
  resetCrop();
  refresh();
});
$('reset-color').addEventListener('click', () => {
  $('colors').value = 256;
  $('dither').checked = true;
  $('webp-quality').value = 85;
  $('webp-lossless').checked = false;
  $('size-limit').value = '0';
  syncReadouts();
});

/* ---------------------------------------------------------- the GIF view */

/**
 * Show the selected frame: as the finished GIF frame, or — while Edit crop
 * is on — the whole frame with the crop box over it.
 */
function showSelected() {
  if (!clip || !plan || previewing) return;
  const k = Math.max(0, Math.min(clip.count - 1, strip.selected < 0 ? sel.start : strip.selected));
  drawGifFrame(k);
}

/*
 * Frames come from the store, which may have to decode one first. A frame
 * still decoding when a newer one is asked for is not drawn when it arrives:
 * the newest request wins, so stepping fast never shows frames out of order.
 */
let drawToken = 0;

function drawGifFrame(k) {
  if (!clip) return;
  const token = ++drawToken;
  const ready = clip.store.peek(k);
  if (ready) { paintGifFrame(k, ready); return; }
  const store = clip.store;
  store.get(k).then((bitmap) => {
    if (token === drawToken && clip?.store === store) paintGifFrame(k, bitmap);
  }, () => {});
}

function paintGifFrame(k, bitmap) {
  showFrameNumber(k);
  const editing = $('crop-edit').checked && $('crop-aspect').value !== 'off';
  if (editing) {
    if (gifCanvas.width !== clip.workW || gifCanvas.height !== clip.workH) {
      gifCanvas.width = clip.workW;
      gifCanvas.height = clip.workH;
      fitCanvas();
    }
    gifCtx.drawImage(bitmap, 0, 0);
    if (!cropTool.visible) cropTool.show(gifCanvas, clip.srcW, clip.srcH, crop, cropAspect());
    else { cropTool.aspect = cropAspect(); cropTool.crop = { ...crop }; cropTool.place(); }
    return;
  }
  cropTool.hide();
  const h = plan.height + plan.band;
  if (gifCanvas.width !== plan.width || gifCanvas.height !== h) {
    gifCanvas.width = plan.width;
    gifCanvas.height = h;
    fitCanvas();
  }
  if (plan.band) gifCtx.clearRect(0, 0, plan.width, plan.band);
  drawFrame(gifCtx, bitmap, scaleCrop(plan.crop, clip.scale), plan);
}

/**
 * Size the canvas on screen: as large as its stage allows, keeping its shape.
 * Small GIFs are blown up with hard pixel edges, so what you see is what the
 * GIF holds rather than a blur of it.
 */
function fitCanvas() {
  const stage = $('gif-stage');
  const pad = 16;
  const sw = stage.clientWidth - pad;
  const sh = stage.clientHeight - pad;
  if (sw <= 0 || sh <= 0) return;
  const fit = Math.min(sw / gifCanvas.width, sh / gifCanvas.height);
  // Actual pixels: the size a browser shows the GIF at, one GIF pixel to a
  // CSS pixel — shrunk only if it would not otherwise fit. Off, small GIFs are
  // blown up to fill the view.
  const scale = $('actual-pixels').checked ? Math.min(1, fit) : fit;
  gifCanvas.style.width = `${Math.floor(gifCanvas.width * scale)}px`;
  gifCanvas.style.height = `${Math.floor(gifCanvas.height * scale)}px`;
  gifCanvas.classList.toggle('pixelated', scale >= 2);
  cropTool.place();
}
new ResizeObserver(() => fitCanvas()).observe($('gif-stage'));
$('actual-pixels').addEventListener('input', () => fitCanvas());


/* -------------------------------------------------------------- preview */

/*
 * Playback is a lookup against the clock, not a frame counter, as in the
 * spinning GIF maker: a slow frame or a background tab lands on the frame
 * that belongs to the current time instead of drifting behind. The timing
 * is the GIF's own, rounded to its 10 ms grid, so what plays is what saves.
 */
let previewing = false;
let previewEpoch = 0;
let previewShown = -1;
let previewRaf = 0;
let cycle = { starts: [], totalMs: 0 };
let rate = { shown: 0, since: 0 };
/** Frames the preview decodes ahead of the one showing. */
const PREFETCH_AHEAD = 24;

function rebuildPreviewCycle() {
  if (!plan) return;
  const { starts, totalMs } = frameStarts(plan.gif.delays);
  // Keep the place in the loop when the timing changes under a running preview.
  const offset = previewing && cycle.totalMs ? ((performance.now() - previewEpoch) % cycle.totalMs) / cycle.totalMs : 0;
  cycle = { starts, totalMs };
  if (previewing) previewEpoch = performance.now() - offset * totalMs;
  previewShown = -1;
}

function startPreview() {
  if (!clip || !plan) return;
  if ($('crop-edit').checked) { $('crop-edit').checked = false; cropTool.hide(); }
  previewing = true;
  previewEpoch = performance.now();
  previewShown = -1;
  rate = { shown: 0, since: performance.now() };
  $('gif-play').textContent = '❚❚';
  $('preview-mirror').checked = true;
  player.video.pause();
  previewRaf = requestAnimationFrame(previewTick);
}

function stopPreview() {
  if (!previewing) return;
  previewing = false;
  cancelAnimationFrame(previewRaf);
  $('gif-play').textContent = '▶︎';
  $('preview-mirror').checked = false;
  $('preview-fps').value = '';
  showSelected();
}

function previewTick(now) {
  if (!previewing) return;
  const i = frameIndexAt(cycle.starts, cycle.totalMs, now - previewEpoch);
  if (i !== previewShown) {
    previewShown = i;
    drawGifFrame(plan.kept[i]);
    rate.shown++;
    // The frames about to play, decoded ahead of their turn — wrapping round
    // to the start as the loop will.
    const ahead = [];
    for (let n = 1; n <= PREFETCH_AHEAD && n < plan.kept.length; n++) {
      ahead.push(plan.kept[(i + n) % plan.kept.length]);
    }
    clip.store.prefetch(ahead);
  }
  // The rate actually achieved, once a second.
  if (now - rate.since >= 1000) {
    const fps = (rate.shown * 1000) / (now - rate.since);
    $('preview-fps').value = `${fps.toFixed(1)} / ${plan.gif.fps.toFixed(1)} fps`;
    rate = { shown: 0, since: now };
  }
  previewRaf = requestAnimationFrame(previewTick);
}

$('preview-mirror').addEventListener('input', () => {
  if (!clip) { $('preview-mirror').checked = false; return; }
  if ($('preview-mirror').checked) startPreview(); else stopPreview();
});

/* ---------------------------------------------------------------- saving */

function setSaveEnabled(enabled) {
  document.querySelectorAll('.save').forEach((b) => {
    b.disabled = !enabled || b.dataset.unsupported === 'true';
  });
}

document.querySelectorAll('.save').forEach((b) => {
  b.addEventListener('click', () => save(b.dataset.format));
});
$('save-cancel').addEventListener('click', () => saving?.abort());

/**
 * The finished frames, one at a time, drawn from the converted frames at the
 * plan's size. Nothing is kept between frames.
 *
 * @param {object} p        a plan (see refresh())
 * @param {number[]} which  positions in p.kept, ascending
 */
async function* renderFrames(p, which, signal) {
  const canvas = new OffscreenCanvas(p.width, p.height + p.band);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const frameCrop = scaleCrop(p.crop, clip.scale);
  const store = clip.store;
  for (let n = 0; n < which.length; n++) {
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    // Keep the decoder a little ahead of the encoder.
    if (n % 8 === 0) store.prefetch(which.slice(n + 1, n + 1 + PREFETCH_AHEAD).map((i) => p.kept[i]));
    const bitmap = await store.get(p.kept[which[n]]);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    drawFrame(ctx, bitmap, frameCrop, p);
    yield ctx.getImageData(0, 0, canvas.width, canvas.height);
  }
}

/** The plan at a smaller size, for squeezing a file under a size limit. */
function scaledPlan(p, factor) {
  const width = Math.max(16, Math.round(p.width * factor));
  const height = Math.max(16, Math.round((width * p.height) / p.width));
  const { layer, band } = captionLayer(readCaption(), width, height);
  return { ...p, width, height, layer, band };
}

async function save(format) {
  if (!clip || !plan || saving) return;
  stopPreview();
  saving = new AbortController();
  const { signal } = saving;
  const limitMb = +$('size-limit').value;
  const limit = limitMb ? limitMb * 1000 * 1000 : 0;
  setSaveEnabled(false);
  $('save-cancel').closest('.row').hidden = false;
  $('save-info').textContent = '';

  const startTc = source.timecode(Math.min(source.count - 1, clip.srcIndex[sel.start]));
  const name = `${baseName}_${fileTimecode(startTc)}`;
  let p = plan;
  let note = '';

  try {
    for (let attempt = 0; ; attempt++) {
      const status = (text) => { $('save-status').textContent = text; };
      status(`Making ${FORMAT_LABELS[format]}${attempt ? ` at ${p.width} × ${p.height}` : ''}…`);
      const progress = (done, total) => setProgress('save-progress', done / total);
      const result = await encode(format, p, { signal, progress, status });
      // Over the limit: shrink by the square root of the overshoot, a little
      // more to be sure, and go again. File size follows the pixel count.
      if (limit && result.blob.size > limit && attempt < 5 && format !== 'zip') {
        const factor = Math.sqrt(limit / result.blob.size) * 0.94;
        if (p.width * factor >= 16) {
          p = scaledPlan(p, factor);
          note = ` · shrunk to ${p.width} × ${p.height + p.band} to fit ${limitMb} MB`;
          continue;
        }
      }
      download(result.blob, `${name}.${result.extension}`);
      $('save-info').innerHTML =
        `Saved ${escapeHtml(`${name}.${result.extension}`)} — ${fileSizeHtml(result.blob.size)}` +
        escapeHtml(result.note ? ` · ${result.note}` : '') + escapeHtml(note);
      if (limit && result.blob.size > limit) {
        $('save-info').innerHTML += ` · <span class="caution">still over ${limitMb} MB: try more frame skip or fewer colors</span>`;
      }
      break;
    }
  } catch (err) {
    if (isAbort(err)) $('save-info').textContent = 'Stopped.';
    else {
      console.error(err);
      $('save-info').innerHTML = `<span class="warn">${escapeHtml(friendlyError(err))}</span>`;
    }
  } finally {
    saving = null;
    setProgress('save-progress', null);
    $('save-cancel').closest('.row').hidden = true;
    setSaveEnabled(!!clip);
  }
}

/** Encode one format. Returns { blob, extension, note }. */
async function encode(format, p, { signal, progress, status }) {
  const count = p.kept.length;
  const all = Array.from({ length: count }, (_, i) => i);

  if (format === 'gif') {
    const blob = await encodeGif({
      count,
      render: (which) => renderFrames(p, which, signal),
      delays: p.gif.delays,
      colours: +$('colors').value,
      dither: $('dither').checked,
      onProgress: progress,
      cancelled: () => signal.aborted,
    });
    return { blob, extension: 'gif', note: `${seconds(p.gif.totalMs / 1000)} · ${$('colors').value} colors` };
  }

  if (format === 'webp') {
    const info = summarise(p.idealMs, 'webp');
    const lossless = $('webp-lossless').checked;
    const quality = +$('webp-quality').value / 100;
    const stills = [];
    let i = 0;
    for await (const frame of renderFrames(p, all, signal)) {
      stills.push({ data: await encodeStill(frame, { quality, lossless }), duration: info.delays[i] });
      progress(++i, count);
      await maybeYield();
    }
    status('Assembling WebP…');
    const blob = new Blob(muxAnimationParts(stills, { width: p.width, height: p.height + p.band, loop: 0 }),
      { type: 'image/webp' });
    let note = `${seconds(info.totalMs / 1000)}`;
    if (lossless) note += isLosslessWebp(stills[0].data) ? ' · lossless' : ' · lossy: this browser has no lossless WebP';
    return { blob, extension: 'webp', note };
  }

  if (format === 'zip') {
    // Packed as it goes: a long clip's frames are never all held at once.
    const zip = zipWriter(`${baseName}_frames`);
    let i = 0;
    for await (const frame of renderFrames(p, all, signal)) {
      zip.add(frameName(i, count), encodePng(frame, { level: 6 }));
      progress(++i, count);
      await maybeYield();
    }
    status('Packing ZIP…');
    // The timing travels with the frames, for anyone rebuilding the animation.
    const timing = p.kept.map((k, n) => ({
      file: frameName(n, count),
      videoFrame: clip.srcIndex[k],
      timecode: source.timecode(Math.min(source.count - 1, clip.srcIndex[k])),
      delayMs: Math.round(p.idealMs[n] * 1000) / 1000,
    }));
    zip.add('timing.json', new TextEncoder().encode(JSON.stringify(timing, null, 2)), { compress: true });
    return { blob: zip.finish(), extension: 'zip', note: `${count.toLocaleString()} PNG frames` };
  }
  throw new Error(`Unknown format ${format}`);
}

/** Whether a WebP still holds VP8L, WebP's lossless kind, among its chunks. */
function isLosslessWebp(bytes) {
  for (let i = 12; i + 8 <= bytes.length;) {
    const id = String.fromCharCode(...bytes.subarray(i, i + 4));
    if (id === 'VP8L') return true;
    if (id === 'VP8 ') return false;
    const n = bytes[i + 4] | (bytes[i + 5] << 8) | (bytes[i + 6] << 16) | (bytes[i + 7] << 24);
    i += 8 + n + (n & 1);
  }
  return false;
}

/* ---------------------------------------------------- typing a slider value */

/**
 * Double-clicking a slider's reading turns it into a box you can type in, as
 * in the spinning GIF maker. The value goes back out as an ordinary input
 * event, so everything watching the slider reacts exactly as to a drag.
 */
const NUMBER_IDS = ['skip', 'speed', 'colors', 'webp-quality', 'text-stroke', 'text-size'];

/**
 * Values that can be typed past the slider's own ends. GIF speed's slider
 * stops at 2000%, but any speed can be typed; past the point where every frame
 * is at the 20 ms floor it makes no difference, and the Frames line says so.
 */
const TYPED_RANGE = { speed: [1, 100000] };

/** Each slider's own range, captured before anything stretches it. */
const baseRanges = new Map(NUMBER_IDS.map((id) => {
  const el = $(id);
  return [id, { min: el.min, max: el.max, step: el.step }];
}));

/**
 * Put a typed value on a slider, stretching the slider if it does not reach.
 * The slider keeps holding the value, so there is no second copy to fall out
 * of step; dragging it back inside its usual range restores the usual scale.
 */
function setSliderValue(id, value) {
  const el = $(id);
  const base = baseRanges.get(id);
  el.min = String(Math.min(+base.min, value));
  el.max = String(Math.max(+base.max, value));
  const outside = value < +base.min || value > +base.max;
  el.step = outside ? 'any' : base.step;
  el.value = String(value);
}

for (const id of Object.keys(TYPED_RANGE)) {
  // On change, not input: rescaling mid-drag would move the thumb under the pointer.
  $(id).addEventListener('change', () => {
    const el = $(id);
    const base = baseRanges.get(id);
    const v = +el.value;
    if (v >= +base.min && v <= +base.max) { el.min = base.min; el.max = base.max; el.step = base.step; }
  });
}

function editNumber(id) {
  const out = $(`${id}-out`);
  const slider = $(id);
  if (out.hidden || slider.disabled) return;
  const [lo, hi] = TYPED_RANGE[id] ?? [+baseRanges.get(id).min, +baseRanges.get(id).max];
  const box = document.createElement('input');
  box.type = 'number';
  box.className = 'number-edit';
  box.value = String(+slider.value);
  box.min = String(lo);
  box.max = String(hi);
  box.title = `${lo} to ${hi}`;
  box.step = 'any';
  let closed = false;
  const close = (commit) => {
    if (closed) return;
    closed = true;
    const typed = parseFloat(box.value);
    box.remove();
    out.hidden = false;
    if (!commit || !Number.isFinite(typed)) return;
    setSliderValue(id, Math.min(hi, Math.max(lo, typed)));
    slider.dispatchEvent(new Event('input', { bubbles: true }));
  };
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); close(true); }
    else if (e.key === 'Escape') { e.preventDefault(); close(false); }
    e.stopPropagation();
  });
  box.addEventListener('blur', () => close(true));
  out.hidden = true;
  out.after(box);
  box.focus();
  box.select();
}
for (const id of NUMBER_IDS) {
  $(`${id}-out`).addEventListener('dblclick', () => editNumber(id));
  $(`${id}-out`).title = 'Double-click to type a value';
}

/* ------------------------------------------------------------- keyboard */

/*
 * Keys work anywhere except while typing. The filmstrip takes its own arrows
 * when it has focus (src/filmstrip.js), so the same keys step the video or
 * the strip depending on which was used last.
 */
document.addEventListener('keydown', (e) => {
  const t = e.target;
  const typing = t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement ||
    (t instanceof HTMLInputElement && !['checkbox', 'button'].includes(t.type));
  if (typing || e.altKey || e.ctrlKey || e.metaKey) return;
  if (e.key === 'Escape') { closeSheet(); return; }
  if (!source) return;
  let handled = true;
  switch (e.key) {
    case ' ': player.togglePlay(); break;
    case 'ArrowLeft': case ',': e.shiftKey ? player.stepSeconds(-1) : player.step(-1); break;
    case 'ArrowRight': case '.': e.shiftKey ? player.stepSeconds(1) : player.step(1); break;
    case 'i': case 'I': markHere('in'); break;
    case 'o': case 'O': markHere('out'); break;
    case 'Home': jumpToMark('in'); break;
    case 'End': jumpToMark('out'); break;
    case 'm': case 'M': $('video').muted = !$('video').muted; break;
    case 'p': case 'P': if (clip) (previewing ? stopPreview() : startPreview()); break;
    case 'Enter': if (t === document.body && !$('convert').disabled) requestConvert(); else handled = false; break;
    default: handled = false;
  }
  if (handled) e.preventDefault();
});

/* -------------------------------------------------- keyboard shortcut sheet */

const sheet = document.createElement('div');
sheet.className = 'sheet';
sheet.hidden = true;
sheet.innerHTML = `
  <div class="sheet-card" role="dialog" aria-modal="true" aria-labelledby="sheet-title">
    <h2 id="sheet-title">Keyboard shortcuts</h2>
    <h3>Video</h3>
    <dl>
      <dt><kbd>Space</kbd></dt><dd>Play / pause</dd>
      <dt><kbd>←</kbd> <kbd>→</kbd></dt><dd>Back / forward one frame (also <kbd>,</kbd> <kbd>.</kbd>)</dd>
      <dt><kbd>Shift</kbd> + <kbd>←</kbd> <kbd>→</kbd></dt><dd>Back / forward one second</dd>
      <dt><kbd>I</kbd> <kbd>O</kbd></dt><dd>Mark the start / end</dd>
      <dt><kbd>Home</kbd> <kbd>End</kbd></dt><dd>Go to the start / end mark</dd>
      <dt><kbd>M</kbd></dt><dd>Sound on / off</dd>
    </dl>
    <h3>Frames (click the strip first)</h3>
    <dl>
      <dt><kbd>←</kbd> <kbd>→</kbd></dt><dd>Select the previous / next frame (<kbd>Shift</kbd>: ten)</dd>
      <dt><kbd>S</kbd> <kbd>E</kbd></dt><dd>Make the selected frame the GIF's start / end</dd>
      <dt><kbd>P</kbd></dt><dd>Preview on / off</dd>
    </dl>
    <p class="muted small" style="margin-top:14px">Double-click a slider's number to type a value.</p>
    <button type="button" id="sheet-close" style="margin-top:12px">Close</button>
  </div>`;
document.body.append(sheet);
function closeSheet() { sheet.hidden = true; }
$('shortcuts').addEventListener('click', () => { sheet.hidden = false; $('sheet-close').focus(); });
$('sheet-close').addEventListener('click', closeSheet);
sheet.addEventListener('click', (e) => { if (e.target === sheet) closeSheet(); });

/* --------------------------------------------------------------- start-up */

/** WebP stills come from the browser's own encoder, which Safari lacks. */
async function checkWebp() {
  try {
    const c = new OffscreenCanvas(1, 1);
    c.getContext('2d');
    const blob = await c.convertToBlob({ type: 'image/webp' });
    webpSupported = blob.type === 'image/webp';
  } catch { webpSupported = false; }
  const button = document.querySelector('.save[data-format="webp"]');
  button.dataset.unsupported = String(!webpSupported);
  if (!webpSupported) {
    button.title = 'This browser cannot make WebP images.';
    window.Preflight?.raise('W4');
  }
  if (window.Preflight) window.Preflight.extras = { ...window.Preflight.extras, webp: webpSupported };
}

syncReadouts();
// ?src=<address> opens a video by address, read in pieces with range requests
// — the way to test a video of many gigabytes, which a browser's file picker
// cannot be driven to open from a test. See "Testing" in the README.
const startSrc = new URLSearchParams(location.search).get('src');
if (startSrc) queueMicrotask(() => handleFile(startSrc));
// Sound starts off: a clip being scrubbed through is noise more often than not.
$('video').muted = true;
$('dropzone').hidden = false;
checkWebp();
window.Preflight?.ready();
