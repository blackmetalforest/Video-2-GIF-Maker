# Changelog

The version shown in the app (under the title), `package.json` and the newest
entry here always agree; `node tests/run.mjs` checks it.

## 0.1.0

The first version.

- Open MP4, MOV, WebM and MKV video — H.264, H.265, VP8, VP9 and AV1 —
  decoded by the browser itself, with every frame's real timestamp read from
  the file.
- Anything the browser cannot decode (AVI, WMV, FLV, ProRes, H.265 without a
  hardware decoder…) is converted with ffmpeg inside the page.
- A frame-exact player: HH:MM:SS:FF timecode, frame stepping, a scrub bar
  that shows the marked clip, and Start / End marks.
- Convert to Frames decodes the marked clip plus three frames either side
  into a filmstrip, where the GIF's first and last frames are chosen.
- Frame skip that keeps the GIF at the video's speed, and a GIF speed control.
- Size presets, a drag-to-crop box with fixed shapes, captions (In Front and
  On Top), GIF colours and dithering, WebP quality, and a file size limit.
- Saves GIF, animated WebP, APNG, or a ZIP of PNG frames with their timing.
