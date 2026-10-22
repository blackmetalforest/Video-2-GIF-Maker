/**
 * Video 2 GIF Maker — the app.
 *
 * The flow, top to bottom of the screen:
 *
 *  1. A video is chosen. Its frames are indexed (src/source.js) and it plays
 *     in the player (src/player.js). A file the browser cannot decode goes
 *     through ffmpeg first (src/ffmpeg.js).
 *  2. The start and end are marked on the video.
 *  3. Convert to Frames decodes the marked frames, plus three either side,
 *     into the filmstrip (src/filmstrip.js).
 *  4. The GIF's first and last frame are picked there, and the settings —
 *     frame skip, size, crop, colours, captions — shape it. The GIF view
 *     shows the result, and Preview plays it at its real timing.
 *  5. Save renders every frame again from the video at full quality and
 *     encodes it (src/encoders/).
 */

import { openVideo, NotDecodable, formatFps } from './source.js';
import { Player } from './player.js';
import { Filmstrip } from './filmstrip.js';
import { CropTool } from './crop.js';
import {
  clampCrop, centredCrop, sizeForLongSide, sizeForWidth, sizeForHeight,
  captionLayer, drawFrame, scaleCrop,
} from './compose.js';
import { isBlank } from './overlay-text.js';
import {
  keptFrames, summarise, frameStarts, frameIndexAt, FPS_LIMIT,
} from './encoders/timing.js';
import { encodeGif } from './encoders/gif.js';
import { encodeStill, muxAnimation } from './encoders/webp.js';
import { encodePng } from './encoders/png.js';
import { muxApng } from './encoders/apng.js';
import { encodeZip } from './encoders/frames.js';
import * as ffmpeg from './ffmpeg.js';

const $ = (id) => document.getElementById(id);

/** Extra frames taken either side of the marks, against off-by-one slips. */
const PAD = 3;
/** Memory the converted frames may use for the preview, in bytes. */
const WORK_BUDGET = 640 * 1024 * 1024;
/** The preview never needs frames bigger than this along their long side. */
const WORK_MAX_SIDE = 1280;
/** Past this many frames a conversion is refused: memory, and sense. */
const FRAMES_MAX = 3000;
/** And past this a warning, because the GIF will be enormous. */
const FRAMES_HEAVY = 450;

const FORMAT_LABELS = { gif: 'GIF', webp: 'WebP', apng: 'APNG', zip: 'ZIP' };

/* ------------------------------------------------------------------ state */

let file = null;             // the File chosen
let baseName = 'clip';       // its name without the extension
let source = null;           // VideoSource the player and timecodes use
let mode = 'native';         // 'native' | 'ffmpeg'
let original = null;         // ffmpeg's { codec, width, height } of a converted file
let loadToken = 0;           // bumps on every new file, so stale work can tell
let clip = null;             // the converted frames; see convert()
let sel = { start: 0, end: 0 };
let crop = null;             // { x, y, w, h } in video pixels
let size = { preset: 480, width: 480, height: 270 };
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
  const wrap = $(`${id}-wrap`);
  if (fraction === null || fraction >= 1) { wrap.hidden = true; return; }
  wrap.hidden = false;
  $(id).style.width = `${Math.max(0, fraction) * 100}%`;
}

/** Seconds as people read them: 4.20 s, or 1:04.2 past a minute. */
function seconds(s) {
  if (s < 60) return `${s.toFixed(2)} s`;
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(1).padStart(4, '0')}`;
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
window.addEventListener('dragover', (e) => e.preventDefault());
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
  baseName = chosen.name.replace(/\.[^.]+$/, '') || 'clip';
  $('file-name').value = chosen.name;
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
  syncMarks();
  updateFrameReadout();
  $('scrub').focus({ preventScroll: true });
}

function setTransportEnabled(on) {
  for (const id of ['play', 'step-back', 'step-fwd', 'mark-in', 'mark-out', 'rate', 'mute']) {
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
$('rate').addEventListener('input', () => { $('video').playbackRate = +$('rate').value; });
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
  $('convert').disabled = !ready || !!converting;
  if (!has) $('clip-info').textContent = '—';
  else if (!ready) {
    $('clip-info').textContent = a === null && b === null
      ? 'No marks yet.'
      : a === null ? 'Now mark the start.' : 'Now mark the end.';
  } else {
    const frames = b - a + 1;
    const length = source.times[b] + source.durations[b] - source.times[a];
    let html = `${frames.toLocaleString()} frames · ${seconds(length)}`;
    if (frames + 2 * PAD > FRAMES_MAX) html += ` · <span class="warn">too long: at most ${FRAMES_MAX.toLocaleString()} frames</span>`;
    else if (frames > FRAMES_HEAVY) html += ' · <span class="caution">long: a big GIF</span>';
    $('clip-info').innerHTML = html;
    if (frames + 2 * PAD > FRAMES_MAX) $('convert').disabled = true;
  }
}

/* -------------------------------------------------------------- convert */

$('convert').addEventListener('click', () => convert());
$('convert-cancel').addEventListener('click', () => converting?.abort());

function discardClip() {
  stopPreview();
  if (clip) for (const b of clip.bitmaps) b?.close?.();
  clip = null;
  strip.clear();
  cropTool.hide();
  $('crop-edit').checked = false;
  $('gif-canvas').hidden = true;
  $('gif-placeholder').hidden = false;
  $('preview').disabled = true;
  $('preview').checked = false;
  $('preview-mirror').checked = false;
  $('strip-info').textContent = 'No frames yet.';
  $('view-size').textContent = '';
  $('strip-set-start').disabled = true;
  $('strip-set-end').disabled = true;
  setSaveEnabled(false);
  $('output-info').textContent = 'Convert to Frames first.';
  $('frames-info').textContent = '—';
}

/**
 * Decode the marked frames, and PAD more either side, into the filmstrip.
 *
 * What is kept is a scaled-down copy of each frame, for the preview and the
 * thumbnails — small enough that a few hundred fit in memory. Saving goes
 * back to the video for full-quality frames, so nothing here limits the
 * output.
 */
async function convert() {
  if (!source || converting) return;
  const { in: a, out: b } = player.marks;
  if (a === null || b === null) return;
  player.video.pause();

  const first = Math.max(0, a - PAD);
  const last = Math.min(source.count - 1, b + PAD);
  const count = last - first + 1;
  const token = loadToken;
  converting = new AbortController();
  const { signal } = converting;
  discardClip();
  $('convert').disabled = true;
  $('convert-cancel').disabled = false;
  $('convert-info').textContent = 'Decoding…';
  setProgress('convert-progress', 0);

  // The working copy's size: the video's, unless that would not fit.
  const sw = source.width;
  const sh = source.height;
  const byBudget = Math.sqrt(WORK_BUDGET / (count * sw * sh * 4));
  const scale = Math.min(1, WORK_MAX_SIDE / Math.max(sw, sh), byBudget);
  const workW = Math.max(2, Math.round(sw * scale));
  const workH = Math.max(2, Math.round(sh * scale));

  const times = Array.from({ length: count }, (_, k) => source.times[first + k]);
  const durations = Array.from({ length: count }, (_, k) => source.durations[first + k]);
  const next = {
    first, count, times, durations,
    srcW: sw, srcH: sh, workW, workH, scale: workW / sw,
    bitmaps: new Array(count).fill(null),
    padBefore: a - first,
    padAfter: last - b,
    decode: null,             // { source, indices } for full-quality frames
    label: (k) => (first + k).toLocaleString(),
  };
  strip.reset(count, sw / sh, next.label);
  $('strip-info').textContent = 'Converting…';

  try {
    let decodeFrom = source;
    let indices = Array.from({ length: count }, (_, k) => first + k);
    if (mode === 'ffmpeg') {
      // ffmpeg cuts the range out of the original at full size, and that cut
      // is what every frame comes from from now on.
      $('convert-info').textContent = 'Cutting the frames out with ffmpeg…';
      const cut = await ffmpeg.makeClip(file, {
        startTime: source.times[first],
        frameDuration: source.typicalStep,
        count,
        signal,
        onProgress: (f) => setProgress('convert-progress', f * 0.5),
      });
      decodeFrom = await openVideo(cut);
      if (decodeFrom.count < count) {
        console.warn(`ffmpeg cut ${decodeFrom.count} frames, ${count} asked for`);
      }
      indices = Array.from({ length: Math.min(count, decodeFrom.count) }, (_, k) => k);
      next.srcW = decodeFrom.width;
      next.srcH = decodeFrom.height;
      next.scale = workW / decodeFrom.width;
    }
    next.decode = { source: decodeFrom, indices };

    let k = 0;
    const base = mode === 'ffmpeg' ? 0.5 : 0;
    for await (const { canvas } of decodeFrom.frames(indices, { signal })) {
      const bitmap = await createImageBitmap(canvas, {
        resizeWidth: workW, resizeHeight: workH, resizeQuality: 'high',
      });
      next.bitmaps[k] = bitmap;
      strip.draw(k, bitmap);
      k++;
      setProgress('convert-progress', base + (k / indices.length) * (1 - base));
      $('convert-info').textContent = `Decoding… ${k} of ${indices.length}`;
    }
    if (token !== loadToken) return;
    // A short cut (ffmpeg found fewer frames than asked) trims the strip.
    if (k < count) {
      next.count = k;
      next.times.length = k;
      next.durations.length = k;
      next.bitmaps.length = k;
      next.padAfter = Math.max(0, next.padAfter - (count - k));
      strip.reset(k, sw / sh, next.label);
      next.bitmaps.forEach((bmp, i) => strip.draw(i, bmp));
    }
    clip = next;
    sel = { start: clip.padBefore, end: Math.max(clip.padBefore, clip.count - 1 - clip.padAfter) };
    $('convert-info').textContent = `${clip.count} frames, ${PAD} extra either side of the marks.`;
    clipReady();
  } catch (err) {
    for (const bmp of next.bitmaps) bmp?.close?.();
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
  $('preview').disabled = false;
  $('strip-set-start').disabled = false;
  $('strip-set-end').disabled = false;
  strip.select(sel.start, { scroll: false });
  strip.centre(sel.start);
  setSaveEnabled(true);
  refresh();
}

/* ------------------------------------------------------------ filmstrip */

strip.addEventListener('select', () => {
  stopPreview();
  showSelected();
  // Keep the video on the same frame, so the two views agree.
  if (clip && source && !player.playing) {
    const k = clip.first + strip.selected;
    if (k < source.count) player.seekFrame(k);
  }
});
strip.addEventListener('set', (e) => setEnd(e.detail.which));
$('strip-set-start').addEventListener('click', () => setEnd('start'));
$('strip-set-end').addEventListener('click', () => setEnd('end'));

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
  syncSizeFromCrop();
  refresh();
});
$('crop-edit').addEventListener('input', () => refresh());

cropTool.addEventListener('input', (e) => {
  crop = { ...e.detail, srcW: crop.srcW, srcH: crop.srcH };
  syncSizeFromCrop();
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

/** The output size follows the crop: the preset's long side, or the typed width. */
function syncSizeFromCrop() {
  if (!crop) return;
  const next = size.preset !== null
    ? sizeForLongSide(crop, size.preset)
    : sizeForWidth(crop, size.width);
  size = { ...size, ...next };
  $('out-width').value = size.width;
  $('out-height').value = size.height;
}

$('preset').addEventListener('input', () => {
  const v = $('preset').value;
  size.preset = v === '' ? null : +v;
  syncSizeFromCrop();
  refresh();
});
for (const id of ['out-width', 'out-height']) {
  $(id).addEventListener('change', () => {
    if (!crop) return;
    const typed = Math.max(16, Math.min(4096, Math.round(+$(id).value) || 16));
    const next = id === 'out-width' ? sizeForWidth(crop, typed) : sizeForHeight(crop, typed);
    size = { preset: null, ...next };
    $('preset').value = '';
    $('out-width').value = size.width;
    $('out-height').value = size.height;
    refresh();
  });
}

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
  syncSizeFromCrop();

  const { kept, idealMs } = readTiming();
  const gif = summarise(idealMs, 'gif');
  const caption = readCaption();
  const { layer, band } = captionLayer(caption, size.width, size.height);
  plan = {
    kept, idealMs, gif,
    width: size.width, height: size.height, band, layer,
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
  const tc = (k) => source?.timecode(Math.min(source.count - 1, clip.first + k)) ?? '';
  $('strip-info').innerHTML =
    `GIF: <strong>${tc(sel.start)}</strong> → <strong>${tc(sel.end)}</strong> · ` +
    `${sel.end - sel.start + 1} frames, ${kept.length} kept`;
  let html = `${kept.length} frames · ${gif.fps.toFixed(gif.fps < 10 ? 1 : 0)} fps · ${seconds(gif.totalMs / 1000)}`;
  if (gif.slowed) {
    html += ` · <span class="caution">too fast for GIF players (max ${FPS_LIMIT} fps), so it plays slower — use Frame skip</span>`;
  }
  $('frames-info').innerHTML = html;
  $('output-info').innerHTML =
    `${plan.width} × ${plan.height + plan.band} px · ${kept.length} frames · ${seconds(gif.totalMs / 1000)}`;
}

function updateSizeReadouts() {
  if (!clip) { $('view-size').textContent = ''; return; }
  $('view-size').textContent = `${size.width} × ${size.height + (plan?.band ?? 0)}`;
}

/** The slider readings and notes that do not depend on frames. */
function syncReadouts() {
  const skip = +$('skip').value;
  $('skip-out').value = String(skip);
  $('skip-note').textContent = skip === 0 ? 'Every frame is kept.'
    : skip === 1 ? 'Every 2nd frame is kept, each shown twice as long.'
      : `Every ${ordinal(skip + 1)} frame is kept, each shown ${skip + 1}× as long.`;
  $('speed-out').value = `${$('speed').value}%`;
  $('colours-out').value = $('colours').value;
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
for (const id of ['colours', 'webp-quality', 'webp-lossless', 'dither', 'size-limit']) {
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
  $('speed').value = 100;
  if (clip) sel = { start: clip.padBefore, end: Math.max(clip.padBefore, clip.count - 1 - clip.padAfter) };
  refresh();
});
$('reset-size').addEventListener('click', () => {
  $('preset').value = '480';
  size = { preset: 480, width: 480, height: 270 };
  $('crop-aspect').value = 'off';
  $('crop-rows').hidden = true;
  $('crop-edit').checked = false;
  resetCrop();
  refresh();
});
$('reset-colour').addEventListener('click', () => {
  $('colours').value = 256;
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

function drawGifFrame(k) {
  const bitmap = clip.bitmaps[k];
  if (!bitmap) return;
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
  const scale = Math.min(sw / gifCanvas.width, sh / gifCanvas.height);
  gifCanvas.style.width = `${Math.floor(gifCanvas.width * scale)}px`;
  gifCanvas.style.height = `${Math.floor(gifCanvas.height * scale)}px`;
  gifCanvas.classList.toggle('pixelated', scale >= 2);
  cropTool.place();
}
new ResizeObserver(() => fitCanvas()).observe($('gif-stage'));

$('show-border').addEventListener('input', () => {
  gifCanvas.classList.toggle('show-border', $('show-border').checked);
});

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
  $('preview').checked = true;
  $('preview-mirror').checked = true;
  player.video.pause();
  previewRaf = requestAnimationFrame(previewTick);
}

function stopPreview() {
  if (!previewing) return;
  previewing = false;
  cancelAnimationFrame(previewRaf);
  $('preview').checked = false;
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
  }
  // The rate actually achieved, once a second.
  if (now - rate.since >= 1000) {
    const fps = (rate.shown * 1000) / (now - rate.since);
    $('preview-fps').value = `${fps.toFixed(1)} / ${plan.gif.fps.toFixed(1)} fps`;
    rate = { shown: 0, since: now };
  }
  previewRaf = requestAnimationFrame(previewTick);
}

$('preview').addEventListener('input', () => ($('preview').checked ? startPreview() : stopPreview()));
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
 * Render frames at full quality, straight from the video, at the plan's size.
 * Yields one ImageData at a time; nothing is kept between frames.
 *
 * @param {object} p        a plan (see refresh())
 * @param {number[]} which  positions in p.kept, ascending
 */
async function* renderFrames(p, which, signal) {
  const { source: from, indices } = clip.decode;
  const canvas = new OffscreenCanvas(p.width, p.height + p.band);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  // The full-size crop, in the decoded frame's pixels.
  const fullCrop = scaleCrop(p.crop, from.width / clip.srcW);
  const wanted = which.map((i) => indices[p.kept[i]]);
  for await (const { canvas: frame } of from.frames(wanted, { signal })) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    drawFrame(ctx, frame, fullCrop, p);
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

  const startTc = source.timecode(Math.min(source.count - 1, clip.first + sel.start));
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
        $('save-info').innerHTML += ` · <span class="caution">still over ${limitMb} MB: try more frame skip or fewer colours</span>`;
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
      colours: +$('colours').value,
      dither: $('dither').checked,
      onProgress: progress,
      cancelled: () => signal.aborted,
    });
    return { blob, extension: 'gif', note: `${seconds(p.gif.totalMs / 1000)} · ${$('colours').value} colours` };
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
    }
    const blob = new Blob([muxAnimation(stills, { width: p.width, height: p.height + p.band, loop: 0 })],
      { type: 'image/webp' });
    let note = `${seconds(info.totalMs / 1000)}`;
    if (lossless) note += isLosslessWebp(stills[0].data) ? ' · lossless' : ' · lossy: this browser has no lossless WebP';
    return { blob, extension: 'webp', note };
  }

  if (format === 'apng' || format === 'zip') {
    const info = summarise(p.idealMs, 'apng');
    const pngs = [];
    let i = 0;
    for await (const frame of renderFrames(p, all, signal)) {
      pngs.push(encodePng(frame, { level: 6 }));
      progress(++i, count);
      await new Promise((r) => setTimeout(r, 0));
    }
    if (format === 'apng') {
      status('Assembling APNG…');
      const frames = pngs.map((data, k) => ({ data, delay: info.delays[k] }));
      const blob = new Blob([muxApng(frames, { width: p.width, height: p.height + p.band, loop: 0 })],
        { type: 'image/apng' });
      return { blob, extension: 'png', note: `${seconds(info.totalMs / 1000)} · lossless` };
    }
    status('Packing ZIP…');
    // The timing travels with the frames, for anyone rebuilding the animation.
    const timing = p.kept.map((k, n) => ({
      file: `frame_${String(n).padStart(Math.max(3, String(count - 1).length), '0')}.png`,
      videoFrame: clip.first + k,
      timecode: source.timecode(Math.min(source.count - 1, clip.first + k)),
      delayMs: Math.round(p.idealMs[n] * 1000) / 1000,
    }));
    const blob = encodeZip(pngs, {
      name: `${baseName}_frames`,
      extra: { 'timing.json': new TextEncoder().encode(JSON.stringify(timing, null, 2)) },
    });
    return { blob, extension: 'zip', note: `${count} PNG frames` };
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
const NUMBER_IDS = ['skip', 'speed', 'colours', 'webp-quality', 'text-stroke', 'text-size'];
function editNumber(id) {
  const out = $(`${id}-out`);
  const slider = $(id);
  if (out.hidden || slider.disabled) return;
  const box = document.createElement('input');
  box.type = 'number';
  box.className = 'number-edit';
  box.value = String(+slider.value);
  box.min = slider.min;
  box.max = slider.max;
  box.step = 'any';
  let closed = false;
  const close = (commit) => {
    if (closed) return;
    closed = true;
    const typed = parseFloat(box.value);
    box.remove();
    out.hidden = false;
    if (!commit || !Number.isFinite(typed)) return;
    slider.value = String(Math.min(+slider.max, Math.max(+slider.min, typed)));
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
    case 'Enter': if (t === document.body && !$('convert').disabled) convert(); else handled = false; break;
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
$('dropzone').hidden = false;
checkWebp();
window.Preflight?.ready();
