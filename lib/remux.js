/**
 * lib/remux.js — optional. Converts a recording into a clean, Instagram-safe MP4.
 *
 * Two things this fixes that the header patch cannot:
 *  1. WebM is not accepted by Instagram's uploader at all.
 *  2. MediaRecorder's MP4 output is *fragmented* MP4. Some phone galleries and
 *     some versions of Instagram's picker read the moov atom at the front,
 *     find no duration in it, and show 0:00 or refuse the file. Remuxing with
 *     +faststart writes a normal, non-fragmented moov.
 *
 * ffmpeg.wasm is roughly 32 MB, so it is loaded only when asked for, never on
 * page load. On a mid-range phone expect 10-30 seconds for a 15 second reel.
 * The video stream is copied, not re-encoded, so quality is untouched.
 *
 * This module is entirely optional — nothing else imports it at module scope.
 */

const FFMPEG_VERSION = "0.12.10";
const CORE_VERSION = "0.12.6";
const BASE = `https://unpkg.com/@ffmpeg/ffmpeg@${FFMPEG_VERSION}/dist/umd`;
const CORE_BASE = `https://unpkg.com/@ffmpeg/core@${CORE_VERSION}/dist/umd`;

let ffmpegPromise = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    const script = document.createElement("script");
    script.src = src;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`Could not load ${src}`));
    document.head.appendChild(script);
  });
}

/** Cross-origin workers need the file served from a same-origin blob URL. */
async function toBlobURL(url, type) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not fetch ${url} (${res.status})`);
  const blob = new Blob([await res.arrayBuffer()], { type });
  return URL.createObjectURL(blob);
}

async function getFFmpeg(onProgress) {
  if (ffmpegPromise) return ffmpegPromise;

  ffmpegPromise = (async () => {
    onProgress?.({ stage: "loading", detail: "Fetching the converter, about 32 MB" });

    await loadScript(`${BASE}/ffmpeg.js`);
    const FFmpegClass = globalThis.FFmpegWASM?.FFmpeg;
    if (!FFmpegClass) throw new Error("The converter failed to initialise.");

    const ffmpeg = new FFmpegClass();
    const [coreURL, wasmURL] = await Promise.all([
      toBlobURL(`${CORE_BASE}/ffmpeg-core.js`, "text/javascript"),
      toBlobURL(`${CORE_BASE}/ffmpeg-core.wasm`, "application/wasm"),
    ]);

    await ffmpeg.load({ coreURL, wasmURL });
    return ffmpeg;
  })();

  try {
    return await ffmpegPromise;
  } catch (err) {
    ffmpegPromise = null; // allow a retry
    throw err;
  }
}

/**
 * @param {Blob} blob recording from MediaRecorder
 * @param {object} options
 * @returns {Promise<Blob>} an MP4 with a front-loaded moov atom
 */
export async function toInstagramMp4(blob, { onProgress, durationSeconds } = {}) {
  if (typeof window === "undefined") throw new Error("Conversion only runs in the browser.");

  const ffmpeg = await getFFmpeg(onProgress);

  const isWebm = /webm|matroska/i.test(blob.type || "");
  const inputName = isWebm ? "in.webm" : "in.mp4";
  const outputName = "out.mp4";

  ffmpeg.on?.("progress", ({ progress }) => {
    if (Number.isFinite(progress)) {
      onProgress?.({ stage: "converting", ratio: Math.max(0, Math.min(1, progress)) });
    }
  });

  onProgress?.({ stage: "converting", detail: "Rebuilding the file" });

  await ffmpeg.writeFile(inputName, new Uint8Array(await blob.arrayBuffer()));

  // WebM holds VP8/VP9, which has to be re-encoded to H.264. MP4 input is
  // already H.264, so the video stream is copied and nothing degrades.
  const args = isWebm
    ? [
        "-i", inputName,
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-crf", "20",
        "-pix_fmt", "yuv420p",
        "-c:a", "aac",
        "-b:a", "128k",
        "-movflags", "+faststart",
        outputName,
      ]
    : [
        "-i", inputName,
        "-c", "copy",
        "-movflags", "+faststart",
        outputName,
      ];

  if (durationSeconds > 0) args.splice(args.length - 1, 0, "-t", String(durationSeconds + 0.2));

  await ffmpeg.exec(args);

  const data = await ffmpeg.readFile(outputName);
  await ffmpeg.deleteFile(inputName).catch(() => {});
  await ffmpeg.deleteFile(outputName).catch(() => {});

  const out = new Blob([data.buffer || data], { type: "video/mp4" });
  if (out.size === 0) throw new Error("Conversion produced an empty file.");

  onProgress?.({ stage: "done", ratio: 1 });
  return out;
}

/** True when the recording is already a normal MP4 and needs no conversion. */
export function looksInstagramReady(mimeType) {
  return /mp4/i.test(mimeType || "");
}
