/**
 * lib/download.js
 *
 * Saves the final rendered file. MP4 recordings from MediaRecorder can be
 * fragmented and still report 0:00/0:01 to galleries or Instagram. Before
 * saving an MP4 we therefore remux it through the existing ffmpeg.wasm path.
 * The saved file is the remuxed file, not the raw MediaRecorder blob.
 */

import { toInstagramMp4 } from "./remux.js";

export function isMobile() {
  if (typeof navigator === "undefined") return false;
  return (
    /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}

export function isIOS() {
  if (typeof navigator === "undefined") return false;
  return (
    /iPhone|iPad|iPod/i.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}

function extensionFor(mimeType, fallback = "mp4") {
  const type = (mimeType || "").toLowerCase();
  if (type.includes("mp4")) return "mp4";
  if (type.includes("matroska")) return "mkv";
  if (type.includes("webm")) return "webm";
  if (type.includes("jpeg") || type.includes("jpg")) return "jpg";
  if (type.includes("png")) return "png";
  return fallback;
}

/**
 * @param {Blob} blob
 * @param {string} baseName filename without extension
 * @returns {Promise<{method: string, filename: string, note?: string}>}
 */
export async function saveFile(blob, baseName, options = {}) {
  if (!blob || blob.size === 0) {
    throw new Error("The file is empty. Render it again before saving.");
  }

  const { durationSeconds, onProgress } = options;
  let finalBlob = blob;

  // Normalize every video with the export pipeline. The measured renderer
  // duration is passed explicitly because MediaRecorder MP4 timing can be wrong.
  if (/video\\\/(mp4|webm|matroska)|mp4|m4v|quicktime/i.test(blob.type || "")) {
    finalBlob = await toInstagramMp4(blob, { durationSeconds, onProgress });
  }

  const ext = extensionFor(finalBlob.type);
  const filename = `${baseName}.${ext}`;
  const file = new File([finalBlob], filename, {
    type: finalBlob.type || "application/octet-stream",
    lastModified: Date.now(),
  });

  // 1. Share sheet. The only path that reliably lands in Photos on iOS.
  if (typeof navigator !== "undefined" && navigator.canShare?.({ files: [file] }) && navigator.share) {
    try {
      await navigator.share({ files: [file], title: filename });
      return {
        method: "share",
        filename,
        note: isIOS()
          ? "Choose Save Video to put it in Photos, then upload from Instagram."
          : "Choose your gallery or Files app to keep it.",
      };
    } catch (err) {
      if (err?.name === "AbortError") return { method: "cancelled", filename };
    }
  }

  // 2. Desktop and Android download path.
  const url = URL.createObjectURL(finalBlob);
  try {
    const anchor = document.createElement("a");
    if ("download" in anchor) {
      anchor.href = url;
      anchor.download = filename;
      anchor.rel = "noopener";
      anchor.style.display = "none";
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      setTimeout(() => URL.revokeObjectURL(url), 40000);
      return { method: "download", filename };
    }

    window.open(url, "_blank");
    setTimeout(() => URL.revokeObjectURL(url), 120000);
    return {
      method: "opened",
      filename,
      note: "Press and hold the video, then choose Save, to keep it on this device.",
    };
  } catch (err) {
    URL.revokeObjectURL(url);
    throw new Error(`Could not save the file: ${err.message}`);
  }
}

export function instagramCheck({ mimeType, durationSeconds, hasAudio, sizeBytes }) {
  const problems = [];
  const warnings = [];

  const type = (mimeType || "").toLowerCase();
  if (!type.includes("mp4")) {
    problems.push(
      "Instagram's uploader only takes MP4 and MOV. This recording is WebM, so convert it before posting."
    );
  }

  if (durationSeconds < 3) problems.push("Reels must run at least 3 seconds. Add scenes or lengthen them.");
  if (durationSeconds > 180) problems.push("Reels cap out at 3 minutes.");
  if (sizeBytes > 650 * 1024 * 1024) {
    warnings.push("The file is large enough that the upload may time out on mobile data.");
  }
  if (!hasAudio) {
    warnings.push("There is no audio track. Instagram accepts silent video, but reach is usually worse.");
  }

  return { ok: problems.length === 0, problems, warnings };
}
