/**
 * Frame-sequence export: a ZIP of the individual PNGs.
 *
 * How frames get into After Effects, Blender or a video editor. Each PNG is
 * lossless, so the ZIP is the one export with no quantising or compression
 * loss at all.
 */

import { Zip, ZipPassThrough, ZipDeflate } from '../../vendor/fflate.module.js';

/** Zero-pad so frames sort correctly in a file browser. */
export function frameName(index, total, ext = 'png') {
  const width = Math.max(3, String(total - 1).length);
  return `frame_${String(index).padStart(width, '0')}.${ext}`;
}

/**
 * A ZIP written as it goes: each file added is packed at once and its bytes
 * handed to a Blob in pieces, so a ZIP of a hundred thousand frames never
 * exists as one buffer. PNG is already deflated, so frames are stored as they
 * are; anything else (the timing file) is compressed.
 *
 * @param {string} folder  the folder everything goes in
 */
export function zipWriter(folder) {
  const pieces = [];
  let pending = [];
  let pendingBytes = 0;
  let failed = null;
  const zip = new Zip((err, data) => {
    if (err) { failed = err; return; }
    pending.push(data);
    pendingBytes += data.length;
    if (pendingBytes >= 8 * 1024 * 1024) flush();
  });
  const flush = () => {
    if (pending.length) pieces.push(new Blob(pending));
    pending = [];
    pendingBytes = 0;
  };
  return {
    add(name, bytes, { compress = false } = {}) {
      const entry = compress ? new ZipDeflate(`${folder}/${name}`, { level: 6 })
        : new ZipPassThrough(`${folder}/${name}`);
      zip.add(entry);
      entry.push(bytes, true);
      if (failed) throw failed;
    },
    finish() {
      zip.end();
      if (failed) throw failed;
      flush();
      return new Blob(pieces, { type: 'application/zip' });
    },
  };
}

/** All at once, for a handful of frames (and the tests). */
export function encodeZip(pngs, { name = 'clip', extra = {} } = {}) {
  const writer = zipWriter(name);
  pngs.forEach((bytes, i) => writer.add(frameName(i, pngs.length), bytes));
  for (const [file, bytes] of Object.entries(extra)) writer.add(file, bytes, { compress: true });
  return writer.finish();
}
