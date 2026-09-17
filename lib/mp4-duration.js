/**
 * lib/mp4-duration.js
 *
 * MediaRecorder's MP4 output is a *fragmented* MP4: an initial `moov` box
 * describing the tracks is written before recording starts, followed by a
 * stream of `moof`+`mdat` fragments as data arrives. Because the final length
 * isn't known when `moov` is written, its duration fields — `mvhd` (movie),
 * `tkhd` (per track) and `mdhd` (per track's media) — are left at 0.
 *
 * A video player scans the `moof`/`tfdt` timestamps and plays the file
 * correctly regardless. A metadata reader — a file browser, a gallery app,
 * Instagram's uploader — reads only the header fields above, sees no
 * duration, and shows something like 0:00 or a meaningless placeholder.
 *
 * This patches every duration field those readers look at, using the real
 * elapsed time measured by the JS recording loop. Every field in ISO-BMFF is
 * fixed-width, so unlike the WebM/EBML case, nothing needs resizing — this is
 * an in-place byte patch on a copy of the buffer.
 *
 * Spec reference: ISO/IEC 14496-12 (ISOBMFF).
 */

const textDecoder = typeof TextDecoder !== "undefined" ? new TextDecoder("ascii") : null;

function typeAt(bytes, pos) {
  if (textDecoder) return textDecoder.decode(bytes.subarray(pos, pos + 4));
  let s = "";
  for (let i = 0; i < 4; i++) s += String.fromCharCode(bytes[pos + i]);
  return s;
}

/**
 * Reads one box header at `pos`. Returns null past the end of the range.
 * Handles the 64-bit largesize form (size field == 1) and the "extends to
 * end" form (size field == 0), both legal ISOBMFF.
 */
function readBoxHeader(view, bytes, pos, end) {
  if (pos + 8 > end) return null;

  const size32 = view.getUint32(pos, false);
  const type = typeAt(bytes, pos + 4);

  if (size32 === 1) {
    if (pos + 16 > end) return null;
    const hi = view.getUint32(pos + 8, false);
    const lo = view.getUint32(pos + 12, false);
    const size = hi * 2 ** 32 + lo; // fine for anything under ~8 PB, i.e. always here
    return { type, headerLen: 16, size, contentStart: pos + 16, contentEnd: pos + size };
  }

  if (size32 === 0) {
    // Box runs to the end of the range it lives in — legal, if unusual, for
    // a final top-level box such as a streamed mdat.
    return { type, headerLen: 8, size: end - pos, contentStart: pos + 8, contentEnd: end };
  }

  return { type, headerLen: 8, size: size32, contentStart: pos + 8, contentEnd: pos + size32 };
}

/** Walk direct children of a plain container box (moov, trak, mdia, mvex, ...). */
function children(view, bytes, start, end, visit) {
  let pos = start;
  while (pos < end) {
    const box = readBoxHeader(view, bytes, pos, end);
    if (!box || box.size <= 0) return;
    if (visit(box)) return;
    pos = box.contentEnd;
  }
}

function findAll(view, bytes, start, end, type) {
  const found = [];
  children(view, bytes, start, end, (box) => {
    if (box.type === type) found.push(box);
    return false;
  });
  return found;
}

function findOne(view, bytes, start, end, type) {
  return findAll(view, bytes, start, end, type)[0] || null;
}

/**
 * Overwrites the duration field of a full-box header (mvhd/tkhd/mdhd/mehd all
 * share this layout: 1 byte version, 3 bytes flags, then version-dependent
 * fixed fields). `durationFieldOffset` locators differ per box type, passed
 * in by the caller.
 */
function patchFullBoxDuration(view, contentStart, layout, durationUnits) {
  const version = view.getUint8(contentStart);
  const offsets = version === 1 ? layout.v1 : layout.v0;
  if (!offsets) return false;

  const at = contentStart + offsets.duration;
  if (version === 1) {
    // 64-bit duration, split as two 32-bit writes (values here never
    // approach the range where that would lose precision).
    const hi = Math.floor(durationUnits / 2 ** 32);
    const lo = durationUnits >>> 0;
    view.setUint32(at, hi, false);
    view.setUint32(at + 4, lo, false);
  } else {
    // 32-bit duration. Clamp rather than overflow into a garbage value on
    // an implausibly long recording.
    view.setUint32(at, Math.min(durationUnits, 0xffffffff), false);
  }
  return true;
}

// Field layout inside each full-box, in bytes from the start of the box's
// content (i.e. right after the 4-byte size + 4-byte type header).
// version/flags = 4 bytes, then the fields below follow in spec order.
const MVHD_LAYOUT = {
  // v0: version/flags(4) creation(4) modification(4) timescale(4) duration(4)
  v0: { timescale: 12, duration: 16 },
  // v1: version/flags(4) creation(8) modification(8) timescale(4) duration(8)
  v1: { timescale: 24, duration: 28 },
};

const TKHD_LAYOUT = {
  // v0: version/flags(4) creation(4) modification(4) track_ID(4) reserved(4) duration(4)
  v0: { duration: 20 },
  // v1: version/flags(4) creation(8) modification(8) track_ID(4) reserved(4) duration(8)
  v1: { duration: 28 },
};

const MDHD_LAYOUT = {
  // v0: version/flags(4) creation(4) modification(4) timescale(4) duration(4)
  v0: { timescale: 12, duration: 16 },
  // v1: version/flags(4) creation(8) modification(8) timescale(4) duration(8)
  v1: { timescale: 24, duration: 28 },
};

const MEHD_LAYOUT = {
  // v0: version/flags(4) fragment_duration(4)
  v0: { duration: 4 },
  // v1: version/flags(4) fragment_duration(8)
  v1: { duration: 4 },
};

function readTimescale(view, contentStart, layout) {
  const version = view.getUint8(contentStart);
  const offsets = version === 1 ? layout.v1 : layout.v0;
  if (!offsets || offsets.timescale == null) return null;
  return view.getUint32(contentStart + offsets.timescale, false);
}

/**
 * @param {Blob} blob         the recording straight from MediaRecorder
 * @param {number} durationMs real length, measured independently in JS
 * @returns {Promise<Blob>} a blob with real durations in every header a
 *   metadata-only reader checks, or the original blob if anything about the
 *   structure doesn't match what's expected (never throws, never corrupts).
 */
export async function fixMp4Duration(blob, durationMs) {
  if (!blob || !Number.isFinite(durationMs) || durationMs <= 0) return blob;
  if (!/mp4|m4v|quicktime/i.test(blob.type || "")) return blob;

  try {
    const buffer = await blob.arrayBuffer();
    const bytes = new Uint8Array(buffer).slice(); // work on a private copy
    const view = new DataView(bytes.buffer);
    const durationSeconds = durationMs / 1000;

    const moov = findOne(view, bytes, 0, bytes.length, "moov");
    if (!moov) return blob; // not a structure we recognise; leave it alone

    let patchedAnything = false;

    // 1. mvhd — the overall movie duration most readers check first.
    const mvhd = findOne(view, bytes, moov.contentStart, moov.contentEnd, "mvhd");
    let movieTimescale = 1000;
    if (mvhd) {
      const ts = readTimescale(view, mvhd.contentStart, MVHD_LAYOUT);
      if (ts) movieTimescale = ts;
      patchedAnything =
        patchFullBoxDuration(view, mvhd.contentStart, MVHD_LAYOUT, Math.round(durationSeconds * movieTimescale)) ||
        patchedAnything;
    }

    // 2. Every trak's tkhd (movie timescale) and mdia/mdhd (its own timescale).
    const traks = findAll(view, bytes, moov.contentStart, moov.contentEnd, "trak");
    for (const trak of traks) {
      const tkhd = findOne(view, bytes, trak.contentStart, trak.contentEnd, "tkhd");
      if (tkhd) {
        patchedAnything =
          patchFullBoxDuration(view, tkhd.contentStart, TKHD_LAYOUT, Math.round(durationSeconds * movieTimescale)) ||
          patchedAnything;
      }

      const mdia = findOne(view, bytes, trak.contentStart, trak.contentEnd, "mdia");
      if (mdia) {
        const mdhd = findOne(view, bytes, mdia.contentStart, mdia.contentEnd, "mdhd");
        if (mdhd) {
          const mediaTimescale = readTimescale(view, mdhd.contentStart, MDHD_LAYOUT) || movieTimescale;
          patchedAnything =
            patchFullBoxDuration(
              view,
              mdhd.contentStart,
              MDHD_LAYOUT,
              Math.round(durationSeconds * mediaTimescale)
            ) || patchedAnything;
        }
      }
    }

    // 3. mvex/mehd — some fragment-aware readers prefer this over mvhd.
    const mvex = findOne(view, bytes, moov.contentStart, moov.contentEnd, "mvex");
    if (mvex) {
      const mehd = findOne(view, bytes, mvex.contentStart, mvex.contentEnd, "mehd");
      if (mehd) {
        patchedAnything =
          patchFullBoxDuration(
            view,
            mehd.contentStart,
            MEHD_LAYOUT,
            Math.round(durationSeconds * movieTimescale)
          ) || patchedAnything;
      }
    }

    if (!patchedAnything) return blob;

    return new Blob([bytes], { type: blob.type });
  } catch {
    // A patched file is nice to have; a working one matters more.
    return blob;
  }
}

export const __test = { readBoxHeader, children, findAll, findOne, MVHD_LAYOUT, TKHD_LAYOUT, MDHD_LAYOUT, MEHD_LAYOUT };