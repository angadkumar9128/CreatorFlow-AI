/**
 * lib/webm-duration.js
 *
 * MediaRecorder writes WebM as a live stream, which means the Segment/Info
 * block ships with no Duration element at all. Desktop players guess the length
 * by scanning to the last cluster, so it looks fine there. Phone galleries and
 * Instagram's uploader read the header only — they see no duration, report
 * 0:00, and reject the file.
 *
 * This walks the EBML tree, finds Segment > Info, and either overwrites an
 * existing Duration or splices a real one in, fixing up the parent size
 * integers as it goes.
 *
 * Does nothing to MP4 — that container has its own (separate) problem, handled
 * in lib/remux.js.
 */

const ID_SEGMENT = 0x18538067;
const ID_INFO = 0x1549a966;
const ID_DURATION = 0x4489;
const ID_TIMECODE_SCALE = 0x2ad7b1;

/** How many bytes this vint occupies, read from its leading-one position. */
function vintLength(firstByte) {
  for (let i = 0; i < 8; i++) {
    if (firstByte & (0x80 >> i)) return i + 1;
  }
  return 0; // invalid
}

function readId(bytes, pos) {
  const len = vintLength(bytes[pos]);
  if (!len || pos + len > bytes.length) return null;
  let id = 0;
  for (let i = 0; i < len; i++) id = id * 256 + bytes[pos + i];
  return { id, len };
}

function readSize(bytes, pos) {
  const len = vintLength(bytes[pos]);
  if (!len || pos + len > bytes.length) return null;

  let value = bytes[pos] & (0xff >> len);
  let allOnes = value === (0xff >> len);

  for (let i = 1; i < len; i++) {
    value = value * 256 + bytes[pos + i];
    if (bytes[pos + i] !== 0xff) allOnes = false;
  }

  return { size: value, len, unknown: allOnes };
}

/** Smallest byte count that can hold this size as a vint. */
function sizeVintLength(value) {
  for (let len = 1; len <= 8; len++) {
    const max = Math.pow(2, 7 * len) - 2; // -1 is reserved for "unknown"
    if (value <= max) return len;
  }
  return 8;
}

function encodeSize(value, forceLength) {
  const len = Math.max(forceLength || 1, sizeVintLength(value));
  const out = new Uint8Array(len);
  let remaining = value;

  for (let i = len - 1; i >= 0; i--) {
    out[i] = remaining % 256;
    remaining = Math.floor(remaining / 256);
  }
  out[0] |= 0x80 >> (len - 1); // length marker
  return out;
}

/** Walk the direct children of a master element. */
function children(bytes, start, end, visit) {
  let pos = start;
  while (pos < end) {
    const idPart = readId(bytes, pos);
    if (!idPart) return;
    const sizePart = readSize(bytes, pos + idPart.len);
    if (!sizePart) return;

    const contentStart = pos + idPart.len + sizePart.len;
    const contentEnd = sizePart.unknown ? end : Math.min(end, contentStart + sizePart.size);

    const stop = visit({
      id: idPart.id,
      idStart: pos,
      idLen: idPart.len,
      sizeStart: pos + idPart.len,
      sizeLen: sizePart.len,
      size: sizePart.size,
      unknown: sizePart.unknown,
      contentStart,
      contentEnd,
    });

    if (stop) return;
    if (sizePart.unknown) return; // cannot safely skip past an unknown-size child
    pos = contentEnd;
  }
}

function findFloat(bytes, start, end, id) {
  let found = null;
  children(bytes, start, end, (el) => {
    if (el.id === id) {
      found = el;
      return true;
    }
    return false;
  });
  return found;
}

function readUint(bytes, start, length) {
  let value = 0;
  for (let i = 0; i < length; i++) value = value * 256 + bytes[start + i];
  return value;
}

/**
 * @param {Blob} blob      the recording straight from MediaRecorder
 * @param {number} durationMs  real length in milliseconds
 * @returns {Promise<Blob>} a blob with a valid Duration, or the original on failure
 */
export async function fixWebmDuration(blob, durationMs) {
  if (!blob || !Number.isFinite(durationMs) || durationMs <= 0) return blob;

  const type = blob.type || "";
  // MP4 and friends are not EBML; leave them alone.
  if (!/webm|matroska/i.test(type)) return blob;

  try {
    const buffer = await blob.arrayBuffer();
    const bytes = new Uint8Array(buffer);

    // 1. locate Segment
    let segment = null;
    children(bytes, 0, bytes.length, (el) => {
      if (el.id === ID_SEGMENT) {
        segment = el;
        return true;
      }
      return false;
    });
    if (!segment) return blob;

    // 2. locate Info inside it
    let info = null;
    children(bytes, segment.contentStart, segment.contentEnd, (el) => {
      if (el.id === ID_INFO) {
        info = el;
        return true;
      }
      return false;
    });
    if (!info || info.unknown) return blob;

    // 3. Duration is expressed in TimecodeScale units, not milliseconds.
    let timecodeScale = 1000000; // 1ms, the MediaRecorder default
    const scaleEl = findFloat(bytes, info.contentStart, info.contentEnd, ID_TIMECODE_SCALE);
    if (scaleEl && scaleEl.size > 0 && scaleEl.size <= 8) {
      const raw = readUint(bytes, scaleEl.contentStart, scaleEl.size);
      if (raw > 0) timecodeScale = raw;
    }
    const durationValue = (durationMs * 1000000) / timecodeScale;

    // 4a. Duration already present -> overwrite in place, no resizing needed.
    const existing = findFloat(bytes, info.contentStart, info.contentEnd, ID_DURATION);
    if (existing && (existing.size === 4 || existing.size === 8)) {
      const out = new Uint8Array(bytes); // copy, never mutate the source
      const view = new DataView(out.buffer);
      if (existing.size === 8) view.setFloat64(existing.contentStart, durationValue, false);
      else view.setFloat32(existing.contentStart, durationValue, false);
      return new Blob([out], { type: blob.type });
    }

    // 4b. Splice a new Duration onto the end of Info.
    const durationEl = new Uint8Array(11);
    durationEl[0] = 0x44;
    durationEl[1] = 0x89;
    durationEl[2] = 0x88; // vint for "8 bytes follow"
    new DataView(durationEl.buffer).setFloat64(3, durationValue, false);

    const newInfoSize = encodeSize(info.size + durationEl.length, info.sizeLen);
    const infoDelta = durationEl.length + (newInfoSize.length - info.sizeLen);

    const parts = [];

    if (segment.unknown) {
      // Live recordings leave Segment open-ended; that stays valid.
      parts.push(bytes.subarray(0, info.sizeStart));
    } else {
      const newSegmentSize = encodeSize(segment.size + infoDelta, segment.sizeLen);
      parts.push(bytes.subarray(0, segment.sizeStart));
      parts.push(newSegmentSize);
      parts.push(bytes.subarray(segment.contentStart, info.sizeStart));
    }

    parts.push(newInfoSize);
    parts.push(bytes.subarray(info.contentStart, info.contentEnd));
    parts.push(durationEl);
    parts.push(bytes.subarray(info.contentEnd));

    const total = parts.reduce((sum, part) => sum + part.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      out.set(part, offset);
      offset += part.length;
    }

    return new Blob([out], { type: blob.type });
  } catch {
    // A patched file is nice to have; a working one matters more.
    return blob;
  }
}

export const __test = { vintLength, readId, readSize, encodeSize, sizeVintLength, children };
