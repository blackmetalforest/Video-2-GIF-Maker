/**
 * Frame timing — how long each GIF frame is shown.
 *
 * A video's frames each have their own presentation time, and the GIF has to
 * reproduce them: a kept frame stays up until the next kept frame's time, so
 * leaving frames out (Frame skip) lengthens the ones that remain and the clip
 * still runs at the video's speed.
 *
 * Every container stores delays on a grid — GIF in hundredths of a second,
 * WebP and APNG in milliseconds — so the ideal delays are rounded onto it
 * with the rounding error carried forward. 30 fps is 33.3 ms a frame, which a
 * GIF cannot hold; rounded naively every frame becomes 30 ms and a 10 s clip
 * plays in 9 s. Carried forward, the frames go 30, 30, 40, 30, 30, 40… and the
 * clip lasts exactly 10 s.
 */

// GIF stores delays in hundredths of a second; WebP and APNG do milliseconds.
export const DELAY_GRID_MS = { gif: 10, webp: 1, apng: 1 };

/*
 * The shortest delay browsers honour. Anything at or under 10 ms is treated
 * as "no delay given" and replaced with 100 ms — a 60 fps GIF would play at
 * a sixth of its speed — so 20 ms (50 fps) is the floor, for every format,
 * because browsers apply the same rule to animated WebP and APNG.
 */
export const MIN_DELAY_MS = 20;
export const FPS_LIMIT = 1000 / MIN_DELAY_MS;

/**
 * Round half to even, the way Python's round() does. Kept from the spinning
 * GIF maker so the two apps round the same timings the same way.
 */
export function roundHalfToEven(value) {
  const floor = Math.floor(value);
  const diff = value - floor;
  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

/**
 * Put ideal delays (ms, any values) onto a format's grid without drifting.
 *
 * Each frame ends as close as the grid allows to where it ideally ends, so
 * the error never accumulates. The floor wins over accuracy: a frame shorter
 * than MIN_DELAY_MS is held for MIN_DELAY_MS, and the clip runs long by the
 * difference — the readout says so (see summarise()).
 */
export function quantizeDelays(idealMs, fmt = 'gif') {
  const grid = DELAY_GRID_MS[fmt] ?? 10;
  const floor = Math.ceil(MIN_DELAY_MS / grid) * grid;
  const out = new Array(idealMs.length);
  let target = 0;
  let elapsed = 0;
  for (let i = 0; i < idealMs.length; i++) {
    target += Math.max(0, idealMs[i]);
    const step = Math.max(floor, roundHalfToEven((target - elapsed) / grid) * grid);
    out[i] = step;
    elapsed += step;
  }
  return out;
}

/** What an animation will actually do once its delays are on the grid. */
export function summarise(idealMs, fmt = 'gif') {
  const delays = quantizeDelays(idealMs, fmt);
  const totalMs = delays.reduce((a, b) => a + b, 0);
  const idealTotal = idealMs.reduce((a, b) => a + Math.max(0, b), 0);
  return {
    delays,
    totalMs,
    idealTotal,
    fps: totalMs ? (1000 * delays.length) / totalMs : 0,
    // Too fast for any player: the floor stretched the clip.
    slowed: idealTotal > 0 && totalMs > idealTotal * 1.02,
  };
}

/**
 * Cumulative start offset of each frame, plus the total. Feeds frameIndexAt().
 */
export function frameStarts(delays) {
  const starts = new Array(delays.length);
  let elapsed = 0;
  for (let i = 0; i < delays.length; i++) {
    starts[i] = elapsed;
    elapsed += delays[i];
  }
  return { starts, totalMs: elapsed };
}

/** How close to a frame's start still counts as reaching it; see frameIndexAt(). */
const FRAME_EDGE_MS = 1e-6;

/**
 * Which frame is on screen `t` ms into the loop.
 *
 * The live preview asks this once per animation frame rather than counting
 * frames as they pass, which is what keeps it honest when it cannot keep up:
 * a backgrounded tab, a rate above the display's refresh, or one slow frame
 * all land on the frame that belongs to the current clock instead of falling
 * behind by however much was missed. `t` is wrapped, so any elapsed time is
 * valid.
 */
export function frameIndexAt(starts, totalMs, t) {
  if (!starts.length) return 0;
  if (!(totalMs > 0)) return 0;
  let time = (t + FRAME_EDGE_MS) % totalMs;
  if (time < 0) time += totalMs;
  // Binary search for the last frame starting at or before `time`.
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= time) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * Which frames make it into the GIF, and how long each would ideally show.
 *
 * `times` and `durations` are the clip's frames in seconds. The first kept
 * frame is `start`; every (skip + 1)th after it is kept, up to `end`. Each
 * kept frame lasts until the next kept one begins, and the last lasts until
 * the end frame itself is over, so the GIF covers exactly start → end of the
 * video whatever the skip. `speed` is a multiplier: 2 plays twice as fast.
 */
export function keptFrames({ times, durations, start, end, skip = 0, speed = 1 }) {
  const step = Math.max(1, Math.floor(skip) + 1);
  const kept = [];
  for (let i = start; i <= end; i += step) kept.push(i);
  const finish = times[end] + durations[end];
  const idealMs = kept.map((i, k) => {
    const next = k + 1 < kept.length ? times[kept[k + 1]] : finish;
    return ((next - times[i]) * 1000) / Math.max(0.01, speed);
  });
  return { kept, idealMs };
}
