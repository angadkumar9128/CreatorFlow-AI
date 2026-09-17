/**
 * lib/remux.js — converts a browser recording into a clean MP4.
 *
 * MediaRecorder MP4 is often fragmented. A file can play for the correct
 * duration while gallery/Instagram metadata still reports 0:00/0:01.
 * Remuxing creates a normal MP4 with a front-loaded moov atom and real
 * duration metadata. WebM is transcoded to H.264/AAC; MP4 keeps its streams.
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

async function toBlobURL(url, type) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not fetch ${url} (${res.status})`);
  return URL.createObjectURL(new Blob([await res.arrayBuffer()], { type }));
}

async function getFFmpeg(onProgress) {
  if (ffmpegPromise) return ffmpegPromise;

  ffmpegPromise = (async () => {
    onProgress?.({ stage: "loading", detail: "Fetching the converter, about 32 MB" });
    await loadScript(`${BASE}/ffmpeg.js`);
    const FFmpegClass = globalThis.FFmpegWASM?.FFmpeg;
    if (!FFmpegClass) throw new Error("The converter failed to initialise.");

    const ffmpeg = new FFmpegClass();

    // IMPORTANT: @ffmpeg/ffmpeg's UMD build creates an internal 814.ffmpeg.js
    // Worker. When ffmpeg.js is loaded from unpkg, that Worker is cross-origin
    // relative to the Vercel app and browsers reject it. Convert the Worker
    // itself to a blob URL so it is created from the app's own origin.
    const [coreURL, wasmURL, classWorkerURL] = await Promise.all([
      toBlobURL(`${CORE_BASE}/ffmpeg-core.js`, "text/javascript"),
      toBlobURL(`${CORE_BASE}/ffmpeg-core.wasm`, "application/wasm"),
      toBlobURL(`${BASE}/814.ffmpeg.js`, "text/javascript"),
    ]);

    await ffmpeg.load({ coreURL, wasmURL, classWorkerURL });
    return ffmpeg;
  })();

  try {
    return await ffmpegPromise;
  } catch (err) {
    ffmpegPromise = null;
    throw err;
  }
}

/**
 * @param {Blob} blob MediaRecorder output
 * @param {object} options
 * @returns {Promise<Blob>} normal, Instagram-friendly MP4
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

  await ffmpeg.writeFile(inputName, new Uint8Array(await blob.arrayBuffer()));
  onProgress?.({ stage: "converting", detail: "Rebuilding the file" });

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
        "-map", "0:v:0",
        "-map", "0:a:0?",
        "-c:v", "copy",
        "-c:a", "copy",
        "-avoid_negative_ts", "make_zero",
        "-movflags", "+faststart",
        outputName,
      ];

  // Use the measured render duration as a hard upper bound, with a tiny
  // allowance for encoder flush so the final frame/audio is not cut off.
  if (Number.isFinite(durationSeconds) && durationSeconds > 0) {
    args.splice(args.length - 1, 0, "-t", String(durationSeconds + 0.2));
  }

  await ffmpeg.exec(args);

  const data = await ffmpeg.readFile(outputName);
  await ffmpeg.deleteFile(inputName).catch(() => {});
  await ffmpeg.deleteFile(outputName).catch(() => {});

  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data.buffer || data);
  const out = new Blob([bytes], { type: "video/mp4" });
  if (out.size === 0) throw new Error("Conversion produced an empty file.");

  onProgress?.({ stage: "done", ratio: 1 });
  return out;
}

export function looksInstagramReady(mimeType) {
  return /mp4/i.test(mimeType || "");
}
