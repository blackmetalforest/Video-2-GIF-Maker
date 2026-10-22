# Video 2 GIF Maker

Cut a clip out of a video, frame by frame, and save it as a **GIF**, an
**animated WebP**, an **APNG** or a **ZIP of PNG frames**.

Everything runs in your browser. Videos are never uploaded — it is a static web
page with no server behind it.

## How it works

1. **Choose a video** — click the file field at the top left, or drop a file
   anywhere on the page.
2. **Scrub to where the GIF should start** and press **⟦ Start** (or `I`). The
   timecode under the video is `hours:minutes:seconds:frame`, and it names the
   exact frame on screen — step with the arrow keys to land on the one you want.
3. **Scrub to the end** and press **End ⟧** (or `O`).
4. **Convert to Frames.** The marked frames, plus three either side in case a
   mark is a frame off, appear as thumbnails along the bottom.
5. **Click a thumbnail, then Set start** (or `S`) — and the same for **Set
   end** (`E`). The video's marks are already selected.
6. **Adjust the settings** on the left: Frame skip, size and crop, colours,
   captions. Skipped frames are greyed in the timeline.
7. **Tick Preview** to watch the GIF play at its real timing.
8. **Save** as GIF, WebP, APNG or a ZIP of frames.

Frame skip keeps the GIF at the video's speed: with a skip of 1, every other
frame is kept and each is shown twice as long, so the clip lasts exactly as
long as it did in the video. **GIF speed** (under Frames → Advanced) plays it
faster or slower.

## Which videos work

| | Works |
| --- | --- |
| **Containers** | MP4, MOV, WebM, MKV — read directly |
| **H.264, VP8, VP9** | Every modern browser |
| **AV1** | Chrome, Edge, Firefox; Safari on recent Apple hardware |
| **H.265 / HEVC** | Safari; Chrome and Edge with a hardware decoder (most Windows and Mac machines). Otherwise converted with ffmpeg |
| **Everything else** — AVI, WMV, FLV, MPEG-2, ProRes… | Converted with ffmpeg |

Files the browser decodes itself open instantly and convert quickly, on the
graphics card. Anything else gets an offer to **Convert with ffmpeg**: FFmpeg
compiled to WebAssembly, running in the page. It downloads 32 MB the first
time and is slow — roughly as long as the video plays, often more — because
GitHub Pages cannot send the headers multi-threaded WebAssembly needs. It makes
a small copy of the whole video to scrub through, then cuts the marked frames
from the original at full quality when you convert.

## Exact frames

Every frame's real presentation time is read from the file
([Mediabunny](https://mediabunny.dev) reads the container), so:

- the timecode counts the frames really in each second, which stays right on
  variable-frame-rate phone video where frames-per-second arithmetic drifts;
- the frame number and timecode follow the picture during playback
  (`requestVideoFrameCallback` reports each frame as it is shown);
- **Convert to Frames** and **Save** decode exactly the frames you marked,
  not whichever a seek happened to land near.

The preview works from a scaled-down copy of each frame. Saving goes back to
the video and decodes every frame again at full size, so the preview's size
never limits the output.

## Timing

GIF stores delays in hundredths of a second, so 30 fps (33.3 ms a frame)
cannot be stored exactly. Delays are rounded with the error carried forward —
30, 30, 40, 30, 30, 40 ms… — so a 10 s clip lasts exactly 10 s rather than
drifting to 9. WebP and APNG store milliseconds.

Browsers replace any delay of 10 ms or less with 100 ms, so nothing can play
faster than 50 fps. A 60 fps clip is held at 20 ms a frame and plays slower;
the Frames section says so, and a Frame skip of 1 fixes it.

## Running it locally

```bash
python3 serve.py
```

Then open <http://localhost:8000>. A static server is needed — ES modules don't
load over `file://`. `serve.py` is `python3 -m http.server` plus a
`Cache-Control: no-cache` header, so an updated file is never mixed with stale
cached ones.

## Publishing on GitHub Pages

The repository is the site — `index.html` is at the root and there is no
build step. [.github/workflows/pages.yml](.github/workflows/pages.yml) runs the
tests and publishes on every push to `main`. In the repository's
**Settings → Pages**, set **Source** to **GitHub Actions** (the workflow also
tries to switch it on by itself).

## Testing

```bash
node tests/run.mjs
```

covers the parts with no browser in them: timing, timecodes and frame lookup,
crop and size arithmetic, and the encoders and muxers.

Decoding needs a real browser and real video. The test videos are generated
with ffmpeg, each with its frame number and timestamp burned in, so a glance
at any exported frame shows whether it is the right one:

```bash
mkdir -p test-videos && cd test-videos
F=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf
VF="drawtext=fontfile=$F:text='%{n}':fontsize=96:fontcolor=white:box=1:boxcolor=black@0.6:x=(w-tw)/2:y=(h-th)/2"
ffmpeg -f lavfi -i testsrc2=size=1280x720:rate=30:duration=20 -vf "$VF" -c:v libx264 -pix_fmt yuv420p h264_30fps.mp4
ffmpeg -f lavfi -i testsrc2=size=1280x720:rate=30:duration=20 -vf "$VF" -c:v libvpx-vp9 vp9_30fps.webm
ffmpeg -f lavfi -i testsrc2=size=1280x720:rate=60:duration=10 -vf "$VF" -c:v libsvtav1 av1_60fps.mp4
ffmpeg -f lavfi -i testsrc2=size=1280x720:rate=30:duration=20 -vf "$VF" -c:v libx265 -tag:v hvc1 hevc_30fps.mp4
ffmpeg -f lavfi -i testsrc2=size=640x360:rate=25:duration=10 -vf "$VF" -c:v libxvid xvid_25fps.avi
ffmpeg -f lavfi -i testsrc2=size=640x360:rate=30000/1001:duration=10 -vf "$VF" -c:v wmv2 wmv2_2997.wmv
```

`test-videos/` is ignored by git.

## Licence

[0BSD](LICENSE) for this project's own code. The libraries in `vendor/` keep
their own licences — see [THIRD-PARTY.md](THIRD-PARTY.md). The ffmpeg core is
GPL; the app works without it for every video the browser decodes itself.
