/**
 * lib/container-sniff.js
 *
 * Deliberately has zero dependencies on MediaRecorder, ffmpeg, or the DOM, so
 * it can run identically in the browser and in a unit test. Two jobs:
 *
 *  1. sniffContainer(bytes) — tells you what a blob actually *is*, by magic
 *     bytes, not by trusting its declared mime type (which can be wrong —
 *     a browser can hand back `video/mp4` for a blob that's structurally
 *     fragmented-but-fine, or, in a bug scenario, code can mislabel a raw
 *     WebM as .mp4). This is the guard that makes "never download WebM
 *     renamed as MP4" an enforced invariant instead of a hope.
 *
 *  2. mp4HasUsableDuration(bytes) — tells you whether an MP4's moov/mvhd
 *     already carries a real duration, which is the fast-path check: if the
 *     browser already produced a proper (or already-patched) MP4, there is
 *     no reason to invoke ffmpeg at all.
 */

/** Reads the first box header at a position. No allocation, just offsets. */
function readBoxHeader(view, pos, end) {
  if (pos + 8 > end) return null;
  const size32 = view.getUint32(pos, false);
  const type = String.fromCharCode(
    view.getUint8(pos + 4),
    view.getUint8(pos + 5),
    view.getUint8(pos + 6),
    view.getUint8(pos + 7)
  );

  if (size32 === 1) {
    if (pos + 16 > end) return null;
    const hi = view.getUint32(pos + 8, false);
    const lo = view.getUint32(pos + 12, false);
    return { type, contentStart: pos + 16, contentEnd: pos + hi * 2 ** 32 + lo };
  }
  if (size32 === 0) return { type, contentStart: pos + 8, contentEnd: end };
  return { type, contentStart: pos + 8, contentEnd: pos + size32 };
}

function findBox(view, start, end, type) {
  let pos = start;
  while (pos < end) {
    const box = readBoxHeader(view, pos, end);
    if (!box) return null;
    if (box.type === type) return box;
    if (box.contentEnd <= pos) return null; // malformed; refuse to loop forever
    pos = box.contentEnd;
  }
  return null;
}

/**
 * @param {Uint8Array} bytes  first ~64KB is plenty; the caller need not hand
 *   over the whole file.
 * @returns {"mp4" | "webm" | "unknown"}
 */
export function sniffContainer(bytes) {
  if (!bytes || bytes.length < 12) return "unknown";

  // WebM/Matroska: EBML header magic, no offset games needed.
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    return "webm";
  }

  // ISO-BMFF (MP4/MOV/M4V): a `ftyp` box, normally the first box but some
  // encoders put a `free` or `wide` box before it, so scan a few candidates.
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 0;
  for (let i = 0; i < 4 && pos + 8 <= bytes.length; i++) {
    const box = readBoxHeader(view, pos, bytes.length);
    if (!box) break;
    if (box.type === "ftyp") return "mp4";
    if (box.contentEnd <= pos) break;
    pos = box.contentEnd;
  }

  return "unknown";
}

/**
 * True only if the MP4 already has a non-zero mvhd duration — meaning either
 * the browser produced a non-fragmented MP4, or it's already been through
 * the header patch in lib/mp4-duration.js. Either way, ffmpeg has nothing
 * useful to add.
 */
export function mp4HasUsableDuration(bytes) {
  if (sniffContainer(bytes) !== "mp4") return false;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const moov = findBox(view, 0, bytes.length, "moov");
  if (!moov) return false;

  const mvhd = findBox(view, moov.contentStart, moov.contentEnd, "mvhd");
  if (!mvhd) return false;

  const version = view.getUint8(mvhd.contentStart);
  const duration =
    version === 1
      ? view.getUint32(mvhd.contentStart + 24, false) * 2 ** 32 + view.getUint32(mvhd.contentStart + 28, false)
      : view.getUint32(mvhd.contentStart + 16, false);

  return duration > 0;
}

/**
 * Decides, from what MediaRecorder can actually produce in this browser,
 * whether the fast path (no ffmpeg) is worth attempting at all. Cheap and
 * synchronous — safe to call before recording starts.
 */
export function canRecordNativeMp4() {
  if (typeof MediaRecorder === "undefined") return false;
  const candidates = [
    "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
    "video/mp4;codecs=avc1,mp4a.40.2",
    "video/mp4;codecs=h264,aac",
    "video/mp4",
  ];
  return candidates.some((type) => MediaRecorder.isTypeSupported(type));
}
