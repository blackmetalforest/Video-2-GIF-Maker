# Third-party components

Everything in `vendor/` is somebody else's work, included here so the app runs
with no build step and makes no requests to anyone else's servers. The
project's own licence ([LICENSE](LICENSE), 0BSD) asks for nothing, but these
do not all take the same view: **every one of them requires its notice to
travel with the copy.** That is what this file and the licence texts beside
the code are for.

If you reuse this project, keep `vendor/` intact — licences and all — or remove
the parts you do not need.

## Code

| Component | Version | Licence | Text |
| --- | --- | --- | --- |
| [Mediabunny](https://mediabunny.dev) — reading MP4, MOV, WebM and MKV, and decoding through WebCodecs | 1.62.0 | MPL-2.0 | [vendor/LICENSES/mediabunny-MPL-2.0.txt](vendor/LICENSES/mediabunny-MPL-2.0.txt) |
| [ffmpeg.wasm](https://github.com/ffmpegwasm/ffmpeg.wasm) `@ffmpeg/ffmpeg` — the JavaScript wrapper | 0.12.15 | MIT | [vendor/LICENSES/ffmpeg.wasm-MIT.txt](vendor/LICENSES/ffmpeg.wasm-MIT.txt) |
| `@ffmpeg/core` — FFmpeg compiled to WebAssembly | 0.12.10 | GPL-2.0-or-later | [vendor/LICENSES/ffmpeg-core-GPL-2.0.txt](vendor/LICENSES/ffmpeg-core-GPL-2.0.txt) |
| [fflate](https://github.com/101arrowz/fflate) — zip and deflate | | MIT | [vendor/LICENSES/fflate-MIT.txt](vendor/LICENSES/fflate-MIT.txt) |
| [gifenc](https://github.com/mattdesl/gifenc) — GIF quantisation and writing | | MIT | [vendor/LICENSES/gifenc-MIT.txt](vendor/LICENSES/gifenc-MIT.txt) |

All are unmodified copies of the published npm packages (Mediabunny's
`dist/bundles/mediabunny.min.mjs`, ffmpeg.wasm's `dist/esm/` files).

### About the GPL'd ffmpeg core

`vendor/ffmpeg-core/` is FFmpeg built with GPL components (x264 and others),
so that one file pair is under the GPL, version 2 or later. It is a separate
program the app loads only when a video needs converting; the rest of the
project is not a derivative of it and keeps its own licence.

The GPL asks that its source be available to anyone who receives the binary.
It is the unmodified `@ffmpeg/core` 0.12.10 release, whose complete source and
build scripts are published at
<https://github.com/ffmpegwasm/ffmpeg.wasm> (tag `v0.12.10`), with FFmpeg's own
source at <https://ffmpeg.org/download.html>.

Anyone who would rather not ship GPL code can delete `vendor/ffmpeg-core/`:
the app still works for every video the browser decodes itself, and reports
that conversion is unavailable for the rest.

## Fonts

The caption fonts, all under the **SIL Open Font License 1.1**, with their
licence texts in [vendor/fonts](vendor/fonts):

| Font | Stands in for | Text |
| --- | --- | --- |
| Anton | Impact | [OFL-Anton.txt](vendor/fonts/OFL-Anton.txt) |
| Oswald | Futura Condensed Extra Bold | [OFL-Oswald.txt](vendor/fonts/OFL-Oswald.txt) |
| Comic Neue | Comic Sans MS | [OFL-ComicNeue.txt](vendor/fonts/OFL-ComicNeue.txt) |
| Arimo | Arial (metrically identical) | [OFL-Arimo.txt](vendor/fonts/OFL-Arimo.txt) |
| Tinos | Times New Roman (metrically identical) | [OFL-Tinos.txt](vendor/fonts/OFL-Tinos.txt) |

## Shared with the Funee Spinning GIF Maker

The GIF, WebP and PNG encoders, the caption layout
(`src/overlay-text.js`), the browser check (`src/preflight.js`) and the look
come from the same author's
[Funee Spinning GIF Maker](https://github.com/blackmetalforest/Funee-Spinning-GIF),
under the same 0BSD licence.
