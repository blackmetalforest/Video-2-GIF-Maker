/**
 * Frame-sequence export: a ZIP of the individual PNGs.
 *
 * How frames get into After Effects, Blender or a video editor. Each PNG is
 * lossless, so the ZIP is the one export with no quantising or compression
 * loss at all.
 */

import { zipSync } from '../../vendor/fflate.module.js';

/** Zero-pad so frames sort correctly in a file browser. */
export function frameName(index, total, ext = 'png') {
  const width = Math.max(3, String(total - 1).length);
  return `frame_${String(index).padStart(width, '0')}.${ext}`;
}

/**
 * Bundle encoded PNGs into a ZIP, in a folder named after the clip.
 * Stored uncompressed: PNG is already deflated, so re-compressing costs time
 * and saves essentially nothing.
 *
 * @param {Uint8Array[]} pngs
 * @param {{name?: string, extra?: Record<string, Uint8Array>}} opts
 */
export function encodeZip(pngs, { name = 'clip', extra = {} } = {}) {
  const entries = {};
  pngs.forEach((bytes, i) => {
    entries[`${name}/${frameName(i, pngs.length)}`] = [bytes, { level: 0 }];
  });
  for (const [file, bytes] of Object.entries(extra)) entries[`${name}/${file}`] = [bytes, { level: 6 }];
  return new Blob([zipSync(entries)], { type: 'application/zip' });
}
