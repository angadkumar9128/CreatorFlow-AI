/**
 * lib/duration-fix.js
 *
 * MediaRecorder never writes a correct duration into either container it can
 * produce, for the same underlying reason: it's streaming output before it
 * knows the final length. Each container hides that fact differently —
 * WebM's Segment/Info block ships with no Duration element at all; MP4's
 * moov header ships with a Duration field present but left at 0. Both look
 * fine in an actual video player, which reads the real per-fragment
 * timestamps; both confuse a metadata-only reader (file browsers, gallery
 * apps, Instagram's uploader), which is the 0:00 / 0:01 symptom.
 *
 * This is the one function callers need: it looks at the blob's mime type
 * and applies whichever fix applies, or returns the blob untouched if
 * neither does.
 */

import { fixWebmDuration } from "./webm-duration.js";
import { fixMp4Duration } from "./mp4-duration.js";

export async function fixContainerDuration(blob, durationMs) {
  if (!blob) return blob;
  const type = blob.type || "";

  if (/webm|matroska/i.test(type)) return fixWebmDuration(blob, durationMs);
  if (/mp4|m4v|quicktime/i.test(type)) return fixMp4Duration(blob, durationMs);

  return blob;
}