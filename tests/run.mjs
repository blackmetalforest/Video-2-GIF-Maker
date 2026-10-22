/**
 * Node tests for the pure-logic modules: timing, frame lookup and timecodes,
 * crop and size arithmetic, and the encoders and muxers.
 *
 * Decoding and the player need a browser and real video; those are checked
 * by hand against the test videos — see "Testing" in the README.
 *
 *   node tests/run.mjs
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import vm from 'vm';

import {
  roundHalfToEven, quantizeDelays, summarise, keptFrames, frameStarts, frameIndexAt,
  MIN_DELAY_MS,
} from '../src/encoders/timing.js';
import { VideoSource, formatFps } from '../src/source.js';
import {
  clampCrop, centredCrop, sizeForLongSide, sizeForWidth, sizeForHeight, scaleCrop,
} from '../src/compose.js';
import { encodeGif, paletteSamples } from '../src/encoders/gif.js';
import { encodePng, readChunks as pngChunks } from '../src/encoders/png.js';
import { muxApng } from '../src/encoders/apng.js';
import { muxAnimation, readChunks as webpChunks } from '../src/encoders/webp.js';
import { frameName, encodeZip } from '../src/encoders/frames.js';
import { unzipSync } from '../vendor/fflate.module.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

let passed = 0;
let failed = 0;

function check(name, condition, detail = '') {
  if (condition) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name} ${detail}`); }
}

const sum = (a) => a.reduce((x, y) => x + y, 0);

console.log('\nversion');
{
  // One number in three places: what the app shows, package.json, and the
  // newest changelog entry. A release that forgets one fails here.
  const html = readFileSync(join(root, 'index.html'), 'utf8');
  const shown = html.match(/id="app-version">V(\d+\.\d+\.\d+)</)?.[1];
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
  const log = readFileSync(join(root, 'CHANGELOG.md'), 'utf8').match(/^## (\d+\.\d+\.\d+)/m)?.[1];
  check('the app shows a MAJOR.MINOR.PATCH version', !!shown, `${shown}`);
  check('package.json carries the same version', pkg === shown, `${pkg} vs ${shown}`);
  check('the newest changelog entry is that version', log === shown, `${log} vs ${shown}`);
}

console.log('\ntiming');
check('banker rounding 12.5 -> 12', roundHalfToEven(12.5) === 12);
check('banker rounding 13.5 -> 14', roundHalfToEven(13.5) === 14);

{
  // 30 fps on GIF's 10 ms grid: 30, 30, 40… and exactly 1 s per 30 frames.
  const ideal = new Array(30).fill(1000 / 30);
  const gif = quantizeDelays(ideal, 'gif');
  check('30 fps GIF delays are on the 10 ms grid', gif.every((d) => d % 10 === 0), gif.join());
  check('30 fps GIF lasts exactly 1000 ms', sum(gif) === 1000, `${sum(gif)}`);
  check('30 fps GIF delays are 30 or 40', gif.every((d) => d === 30 || d === 40));
  const webp = quantizeDelays(ideal, 'webp');
  check('30 fps WebP lasts exactly 1000 ms', sum(webp) === 1000, `${sum(webp)}`);
  check('30 fps WebP delays are 33 or 34', webp.every((d) => d === 33 || d === 34), webp.join());
}
{
  // 29.97 fps over ten seconds: no drift.
  const ideal = new Array(300).fill(1001 / 30);
  const total = sum(quantizeDelays(ideal, 'gif'));
  check('29.97 fps GIF drifts less than one grid step over 300 frames',
    Math.abs(total - 300 * 1001 / 30) <= 10, `${total}`);
}
{
  // 60 fps is faster than players allow: held at the 20 ms floor, and flagged.
  const ideal = new Array(60).fill(1000 / 60);
  const s = summarise(ideal, 'gif');
  check('60 fps is held at the 20 ms floor', s.delays.every((d) => d >= MIN_DELAY_MS), s.delays.join());
  check('60 fps is flagged as slowed', s.slowed === true);
  check('30 fps is not flagged as slowed', summarise(new Array(30).fill(1000 / 30)).slowed === false);
}

console.log('\nkept frames');
{
  const n = 20;
  const times = Array.from({ length: n }, (_, i) => i / 30);
  const durations = new Array(n).fill(1 / 30);
  const all = keptFrames({ times, durations, start: 2, end: 11 });
  check('skip 0 keeps every frame from start to end', all.kept.join() === '2,3,4,5,6,7,8,9,10,11');
  check('skip 0 covers start → end in real time', Math.abs(sum(all.idealMs) - 10000 / 30) < 1e-6);

  const two = keptFrames({ times, durations, start: 2, end: 11, skip: 1 });
  check('skip 1 keeps every other frame', two.kept.join() === '2,4,6,8,10');
  check('skip 1 shows each kept frame twice as long', Math.abs(two.idealMs[0] - 2000 / 30) < 1e-6);
  check('skip 1 still lasts as long as the clip', Math.abs(sum(two.idealMs) - sum(all.idealMs)) < 1e-6);

  const odd = keptFrames({ times, durations, start: 0, end: 9, skip: 3 });
  check('skip 3 keeps 0, 4, 8', odd.kept.join() === '0,4,8');
  check('the last kept frame runs to the end of the end frame',
    Math.abs(odd.idealMs[2] - 2000 / 30) < 1e-6, `${odd.idealMs[2]}`);

  const fast = keptFrames({ times, durations, start: 0, end: 9, speed: 2 });
  check('speed 2 halves the duration', Math.abs(sum(fast.idealMs) - 5000 / 30) < 1e-6);

  const one = keptFrames({ times, durations, start: 5, end: 5, skip: 4 });
  check('a one-frame GIF keeps that frame', one.kept.join() === '5' && Math.abs(one.idealMs[0] - 1000 / 30) < 1e-6);
}

console.log('\nplayback lookup');
{
  const { starts, totalMs } = frameStarts([30, 30, 40]);
  check('frame starts', starts.join() === '0,30,60' && totalMs === 100);
  check('t=0 is frame 0', frameIndexAt(starts, totalMs, 0) === 0);
  check('t=59 is frame 1', frameIndexAt(starts, totalMs, 59) === 1);
  check('t=60 is frame 2', frameIndexAt(starts, totalMs, 60) === 2);
  check('time wraps', frameIndexAt(starts, totalMs, 130) === 1);
}

console.log('\ntimecodes');
{
  const make = (times, durations) => new VideoSource({
    file: null, input: {}, track: { displayWidth: 1280, displayHeight: 720 },
    container: 'MP4', codec: 'H.264', times: Float64Array.from(times), durations: Float64Array.from(durations),
  });
  const n = 100;
  const s = make(Array.from({ length: n }, (_, i) => i / 30), new Array(n).fill(1 / 30));
  check('30 fps is reported as 30', formatFps(s.fps) === '30', formatFps(s.fps));
  check('frame 0 is 00:00:00:00', s.timecode(0) === '00:00:00:00');
  check('frame 29 is 00:00:00:29', s.timecode(29) === '00:00:00:29');
  check('frame 30 is 00:00:01:00', s.timecode(30) === '00:00:01:00');
  check('frame 95 is 00:00:03:05', s.timecode(95) === '00:00:03:05');
  check('indexAt a frame start finds it', s.indexAt(30 / 30) === 30);
  // A time read back from <video> can be a hair short of the frame.
  check('indexAt a hair early still finds it', s.indexAt(30 / 30 - 1e-6) === 30);
  check('indexAt mid-frame', s.indexAt(30.5 / 30) === 30);
  check('seekTime lands inside its frame', s.indexAt(s.seekTime(42)) === 42);
  check('constant rate is not variable', s.variable === false);

  // WebM keeps whole milliseconds: 33, 33, 34 ms. Still 30 fps.
  const ms = Array.from({ length: n }, (_, i) => Math.round((i * 1000) / 30) / 1000);
  const webm = make(ms, ms.map((t, i) => (i + 1 < n ? ms[i + 1] - t : 0.033)));
  check('millisecond timestamps still read as 30 fps', formatFps(webm.fps) === '30', formatFps(webm.fps));
  check('millisecond timestamps are not variable', webm.variable === false);

  // NTSC.
  const ntsc = make(Array.from({ length: n }, (_, i) => (i * 1001) / 30000), new Array(n).fill(1001 / 30000));
  check('29.97 fps is reported as 29.97', formatFps(ntsc.fps) === '29.97', formatFps(ntsc.fps));
  check('29.97: frame 30 is still in second 1', ntsc.timecode(30) === '00:00:01:00', ntsc.timecode(30));

  // Variable frame rate: timecodes count the frames really in each second.
  const vfr = [0, 0.05, 0.1, 0.5, 0.9, 1.0, 1.02, 1.04, 1.5];
  const v = make(vfr, vfr.map((t, i) => (i + 1 < vfr.length ? vfr[i + 1] - t : 0.05)));
  check('variable rate: the 3rd frame of second 1 is :02', v.timecode(7) === '00:00:01:02', v.timecode(7));
  check('variable rate is detected', v.variable === true);

  // Past an hour.
  const late = make([3723.5, 3723.6], [0.1, 0.1]);
  check('hours are counted', late.timecode(1) === '01:02:03:01', late.timecode(1));
}

console.log('\ncrop and size');
{
  check('clampCrop keeps a crop inside the frame',
    JSON.stringify(clampCrop({ x: -10, y: 700, w: 300, h: 100 }, 1280, 720)) === '{"x":0,"y":620,"w":300,"h":100}');
  check('clampCrop shrinks an oversized crop',
    JSON.stringify(clampCrop({ x: 0, y: 0, w: 5000, h: 5000 }, 1280, 720)) === '{"x":0,"y":0,"w":1280,"h":720}');
  const sq = centredCrop(1280, 720, 1);
  check('a square crop of 16:9 is centred', sq.w === 720 && sq.h === 720 && sq.x === 280 && sq.y === 0);
  const tall = centredCrop(1280, 720, 9 / 16);
  check('a 9:16 crop of 16:9 is full height', tall.h === 720 && tall.w === 405, JSON.stringify(tall));
  const full = { x: 0, y: 0, w: 1280, h: 720 };
  const s480 = sizeForLongSide(full, 480);
  check('480 px of 16:9 is 480 × 270', s480.width === 480 && s480.height === 270);
  const port = sizeForLongSide({ x: 0, y: 0, w: 1080, h: 1920 }, 480);
  check('480 px of a portrait video is 270 × 480', port.width === 270 && port.height === 480);
  const small = sizeForLongSide({ x: 0, y: 0, w: 300, h: 200 }, 480);
  check('a preset never scales a video up', small.width === 300 && small.height === 200);
  const orig = sizeForLongSide(full, 0);
  check('Original is the crop size', orig.width === 1280 && orig.height === 720);
  check('a typed width keeps the shape', sizeForWidth(full, 640).height === 360);
  check('a typed height keeps the shape', sizeForHeight(full, 360).width === 640);
  const sc = scaleCrop({ x: 100, y: 50, w: 200, h: 100 }, 0.5);
  check('scaleCrop', sc.x === 50 && sc.y === 25 && sc.w === 100 && sc.h === 50);
}

console.log('\nGIF');
{
  check('palette samples include both ends', (() => {
    const p = paletteSamples(100);
    return p[0] === 0 && p[p.length - 1] === 99 && p.length === 16;
  })());
  check('palette samples of a short clip are every frame', paletteSamples(5).join() === '0,1,2,3,4');

  const W = 16;
  const H = 8;
  const frame = (shade) => {
    const data = new Uint8ClampedArray(W * H * 4);
    for (let i = 0; i < W * H; i++) data.set([shade, 255 - shade, (i * 7) % 256, 255], i * 4);
    return { data, width: W, height: H };
  };
  const frames = [frame(0), frame(80), frame(160), frame(240)];
  const delays = [30, 30, 40, 100];
  const render = async function* (which) { for (const i of which) yield frames[i]; };
  for (const dither of [false, true]) {
    const blob = await encodeGif({ count: 4, render, delays, colours: 64, dither });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const head = String.fromCharCode(...bytes.subarray(0, 6));
    check(`GIF${dither ? ' (dithered)' : ''} has a GIF89a header`, head === 'GIF89a', head);
    // Graphic control extensions: 21 F9 04, then flags, then the delay.
    const found = [];
    for (let i = 0; i + 5 < bytes.length; i++) {
      if (bytes[i] === 0x21 && bytes[i + 1] === 0xf9 && bytes[i + 2] === 0x04) {
        found.push((bytes[i + 4] | (bytes[i + 5] << 8)) * 10);
      }
    }
    check(`GIF${dither ? ' (dithered)' : ''} has four frames with their delays`,
      found.join() === delays.join(), found.join());
    check(`GIF${dither ? ' (dithered)' : ''} ends with a trailer`, bytes[bytes.length - 1] === 0x3b);
  }
  let threw = false;
  try {
    await encodeGif({ count: 2, render, delays, cancelled: () => true });
  } catch (err) { threw = err.name === 'AbortError'; }
  check('a cancelled GIF stops with AbortError', threw);
}

console.log('\nPNG, APNG, ZIP');
{
  const img = { width: 3, height: 2, data: new Uint8ClampedArray(3 * 2 * 4).fill(200) };
  const png = encodePng(img);
  const chunks = pngChunks(png).map((c) => c.type);
  check('PNG chunks are IHDR IDAT IEND', chunks.join() === 'IHDR,IDAT,IEND', chunks.join());
  const apng = muxApng([{ data: png, delay: 33 }, { data: png, delay: 34 }], { width: 3, height: 2 });
  const types = pngChunks(apng).map((c) => c.type);
  check('APNG has acTL before the first IDAT', types.indexOf('acTL') < types.indexOf('IDAT'));
  check('APNG has one fcTL per frame', types.filter((t) => t === 'fcTL').length === 2);
  check('APNG second frame is fdAT', types.includes('fdAT'));
  const fctl = pngChunks(apng).filter((c) => c.type === 'fcTL').map((c) => (c.data[20] << 8) | c.data[21]);
  check('APNG delays are in milliseconds', fctl.join() === '33,34', fctl.join());

  check('frame names sort', frameName(7, 30) === 'frame_007.png' && frameName(7, 2000) === 'frame_0007.png');
  const zip = await encodeZip([png, png], { name: 'clip', extra: { 'timing.json': new TextEncoder().encode('[]') } });
  const files = Object.keys(unzipSync(new Uint8Array(await zip.arrayBuffer()))).sort();
  check('ZIP holds the frames and the timing', files.join() === 'clip/frame_000.png,clip/frame_001.png,clip/timing.json',
    files.join());
}

console.log('\nWebP mux');
{
  // A minimal lossless still: RIFF/WEBP with a VP8L chunk (the bitstream is
  // not decoded by the muxer, only carried).
  const vp8l = new Uint8Array([0x2f, 0x02, 0x40, 0x00, 0x00, 0x07, 0x00]);
  const still = new Uint8Array(12 + 8 + vp8l.length + 1);
  still.set([82, 73, 70, 70], 0);
  const size = still.length - 8;
  still.set([size & 255, (size >> 8) & 255, 0, 0], 4);
  still.set([87, 69, 66, 80, 86, 80, 56, 76, vp8l.length, 0, 0, 0], 8);
  still.set(vp8l, 20);
  const anim = muxAnimation([{ data: still, duration: 33 }, { data: still, duration: 34 }], { width: 3, height: 1 });
  const { chunks } = webpChunks(anim);
  check('animated WebP has VP8X, ANIM and ANMF', !!chunks.VP8X && !!chunks.ANIM && !!chunks.ANMF);
}

console.log('\npreflight');
{
  // The classic script, run in a sandbox with just enough of a browser.
  const code = readFileSync(join(root, 'src', 'preflight.js'), 'utf8');
  const window = {
    document: { addEventListener() {}, getElementById() { return null; } },
    addEventListener() {},
    location: { protocol: 'https:' },
  };
  vm.runInNewContext(code, { window });
  const { checks } = window.Preflight;
  const good = {
    protocol: 'https:', modules: true, offscreen2d: true, imageBitmap: true, readback: 'ok',
    webCodecs: true, frameCallback: true, wasm: true,
  };
  check('a modern browser has no problems', checks(good).length === 0, checks(good).join());
  check('opened from disk is fatal', checks({ ...good, protocol: 'file:' }).includes('F1'));
  check('no WebCodecs is a warning, not fatal', checks({ ...good, webCodecs: false }).join() === 'W1');
  check('blocked read-back is fatal', checks({ ...good, readback: 'blocked' }).includes('F6'));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
