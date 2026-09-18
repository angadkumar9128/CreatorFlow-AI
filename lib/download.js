/**
 * lib/download.js — save path, now with a hard content check.
 *
 * Only change from the previous version: before anything is named or saved
 * as .mp4, its actual bytes are sniffed (lib/container-sniff.js), not just
 * its declared mime type. A blob whose `type` says "video/mp4" but whose
 * bytes are really WebM — a mislabeling bug anywhere upstream — gets caught
 * here rather than reaching the person's camera roll as a file that will
 * fail Instagram's upload silently or with a confusing error.
 */

import { sniffContainer } from "./container-sniff.js";

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

async function realExtension(blob, declaredMime) {
  const head = new Uint8Array(await blob.slice(0, 65536).arrayBuffer());
  const kind = sniffContainer(head);

  if (kind === "mp4") return "mp4";
  if (kind === "webm") return "webm";

  // Not a video at all, or the sniffer didn't recognise it — fall back to
  // the declared mime for non-video assets (images), never for video.
  const type = (declaredMime || "").toLowerCase();
  if (type.includes("jpeg") || type.includes("jpg")) return "jpg";
  if (type.includes("png")) return "png";
  return "bin";
}

/**
 * @param {Blob} blob
 * @param {string} baseName filename without extension
 * @returns {Promise<{method: string, filename: string, note?: string}>}
 */
export async function saveFile(blob, baseName) {
  if (!blob || blob.size === 0) {
    throw new Error("The file is empty. Render it again before saving.");
  }

  const ext = await realExtension(blob, blob.type);

  if (ext === "bin" && /video/i.test(blob.type || "")) {
    throw new Error(
      "This doesn't look like a valid video file (its content doesn't match either MP4 or WebM). Re-render before saving — do not upload this one."
    );
  }

  const filename = `${baseName}.${ext}`;
  const file = new File([blob], filename, {
    type: blob.type || "application/octet-stream",
    lastModified: Date.now(),
  });

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

  const url = URL.createObjectURL(blob);
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
      "Instagram's uploader only takes MP4 and MOV. This recording is WebM — use Convert to MP4 before posting."
    );
  }

  if (durationSeconds < 3) problems.push("Reels must run at least 3 seconds. Add scenes or lengthen them.");
  if (durationSeconds > 180) problems.push("Reels cap out at 3 minutes.");
  if (sizeBytes > 650 * 1024 * 1024) warnings.push("The file is large enough that the upload may time out on mobile data.");
  if (!hasAudio) warnings.push("There is no audio track. Instagram accepts silent video, but reach is usually worse.");

  return { ok: problems.length === 0, problems, warnings };
}
