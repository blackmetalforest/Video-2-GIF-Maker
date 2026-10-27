# Changelog

The version shown in the app (under the title), `package.json` and the newest
entry here always agree; `node tests/run.mjs` checks it.

## 0.2.0

Long videos, and a Clip step that decides how frames are converted.

- Long videos: converted frames are stored as compressed WebP stills and
  decoded on demand, decoding runs straight through the clip, the timeline is
  virtual, and saving streams — tested on a two-hour 1080p video (114,097
  frames).
- Frame size (the video's own by default), Convert skip and Quality are chosen
  before converting, with a memory estimate and a dialog suggesting smaller
  sizes when it is too much. No limit on the number of frames.
- The whole video is marked when it loads.
- A GIF bar under the GIF with the video bar's controls: Start / End, frame
  stepping, play and the frame number. An Actual pixels toggle.
- The video bar: timecode on the left, Start · player buttons · End centred,
  sound off by default, and a second Convert to Frames button.
- GIF size shrinks the output without converting again; GIF speed sits in the
  Frames section, its slider runs to 2000%, and any speed can be typed.
- Fixes: dragging the scrub bar no longer picks up selected text; the file
  name shows in full on hover; "color" spelling throughout.
- `?src=` opens a video by address, read in pieces, for testing long videos;
  `serve.py` answers range requests.
- APNG output removed.

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
  On Top), GIF colors and dithering, WebP quality, and a file size limit.
- Saves GIF, animated WebP, APNG, or a ZIP of PNG frames with their timing.
