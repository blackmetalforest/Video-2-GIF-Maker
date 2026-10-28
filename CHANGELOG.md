# Changelog

The version shown in the app (under the title), `package.json` and the newest
entry here always agree; `node tests/run.mjs` checks it.

## 0.3.0

Finished files that wait for you, and a reworked Frames section.

- Making a file no longer downloads it. The buttons are Make GIF, Make WebP
  and Make ZIP; the finished file replaces the preview (a GIF or WebP plays as
  the real file) and waits for Download at the foot of the Output section, so
  a long render is never lost to a closed save window. Back to editing keeps
  it, Show brings it back, Discard throws it away, and changing a setting
  marks it as made with earlier settings.
- Progress bars at the bottom of each section — Video, Clip and Output — in
  the section's colour, with a line of detail (frames, fps, size, time left)
  and Cancel. The spinner over the video is gone.
- GIF speed runs from 0.1% to 100,000% in round steps, against the original
  video whatever is skipped; any speed can be typed.
- Extra Frame Skip (renamed from Frame skip) never goes below what keeps the
  GIF at 50 fps or less, rising by itself as the speed goes up and returning
  to your own choice when it comes down.
- Pausing the GIF preview stops on the frame on screen and selects it in the
  timeline and the video.
- WebP quality is a menu: Custom (with its own slider), Lossless, High,
  Medium (the default, 75), Low and Comically Low.
- The Color & quality options moved into the Output section. Size limit is
  hidden for now.

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
