/**
 * lib/download.js
 *
 * The blunt reason downloads fail on phones: iOS Safari ignores the `download`
 * attribute on an anchor. Tapping it opens the blob in a new tab as an inline
 * player, the file never reaches the camera roll, and there is nothing for
 * Instagram to pick up. Android Chrome honours `download`, but a large blob URL
 * can still land in Downloads in a way the Instagram picker will not show.
 *
 * The Web Share API is the route that actually works: it hands the real file to
 * the OS share sheet, where "Save Video" writes it to Photos. From there
 * Instagram sees it like any other clip.
 *
 * Order: share sheet -> anchor download -> open in a tab with instructions.
 */

export function isMobile() {
  if (typeof navigator === "undefined") return false;
  return (
    /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1) // iPadOS
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
export async function saveFile(blob, baseName) {
  if (!blob || blob.size === 0) {
    throw new Error("The file is empty. Render it again before saving.");
  }

  const ext = extensionFor(blob.type);
  const filename = `${baseName}.${ext}`;
  const file = new File([blob], filename, {
    type: blob.type || "application/octet-stream",
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
      // AbortError means the user closed the sheet on purpose. Don't fall back.
      if (err?.name === "AbortError") {
        return { method: "cancelled", filename };
      }
      // Anything else: keep going down the list.
    }
  }

  // 2. The desktop path, and Android's usual one.
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

      // Revoking too early cancels the transfer in some browsers.
      setTimeout(() => URL.revokeObjectURL(url), 40000);
      return { method: "download", filename };
    }

    // 3. Last resort: show it and tell the person what to do.
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

/** A short, honest read on whether Instagram will accept this file. */
export function instagramCheck({ mimeType, durationSeconds, hasAudio, sizeBytes }) {
  const problems = [];
  const warnings = [];

  const type = (mimeType || "").toLowerCase();
  if (!type.includes("mp4")) {
    problems.push(
      "Instagram's uploader only takes MP4 and MOV. This recording is WebM, so convert it before posting."
    );
  }

  if (durationSeconds < 3) {
    problems.push("Reels must run at least 3 seconds. Add scenes or lengthen them.");
  }

  if (durationSeconds > 180) {
    problems.push("Reels cap out at 3 minutes.");
  }

  if (sizeBytes > 650 * 1024 * 1024) {
    warnings.push("The file is large enough that the upload may time out on mobile data.");
  }

  if (!hasAudio) {
    warnings.push("There is no audio track. Instagram accepts silent video, but reach is usually worse.");
  }

  return { ok: problems.length === 0, problems, warnings };
}
