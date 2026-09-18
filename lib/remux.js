/**
 * lib/remux.js — converts a browser recording into a clean MP4.
 *
 * MediaRecorder MP4 is often fragmented. A file can play for the correct
 * duration while gallery/Instagram metadata still reports 0:00/0:01.
 * Remuxing creates a normal MP4 with a front-loaded moov atom and real
 * duration metadata. WebM is transcoded to H.264/AAC; MP4 keeps its streams.
 */

const FFMPEG_VERSION = "0.12.10";
const CORE_VERSION = "0.12.10";
// Keep the wrapper and core on the same release. Use jsDelivr, matching the
// official ffmpeg.wasm browser example, for reliable production assets.
const BASE = `https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@${FFMPEG_VERSION}/dist/umd`;
const CORE_BASE = `https://cdn.jsdelivr.net/npm/@ffmpeg/core@${CORE_VERSION}/dist/umd`;

let ffmpegPromise = null;

async function loadFFmpegLibrary() {
  const url = \`${BASE}/ffmpeg.js\`;
  const res = await fetch(url, { cache: "force-cache" });
  if (!res.ok) throw new Error(\`Could not load FFmpeg library (${res.status}): ${url}\`);
  let source = await res.text();

  source = source.replace(
    "new URL(e.p+e.u(814),e.b)",
    "new URL(r.workerLoadURL)"
  );

  const moduleUrl = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
  try {
    await import(moduleUrl);
  } finally {
    URL.revokeObjectURL(moduleUrl);
  }
}

async function getFFmpeg(onProgress) {
  if (ffmpegPromise) return ffmpegPromise;

  ffmpegPromise = (async () => {
    onProgress?.({ stage: "loading", detail: "Fetching the converter, about 32 MB" });
    await loadFFmpegLibrary();
    const FFmpegClass = globalThis.FFmpegWASM?.FFmpeg;
    if (!FFmpegClass) throw new Error("The converter failed to initialise.");

    const ffmpeg = new FFmpegClass();

    // IMPORTANT: @ffmpeg/ffmpeg's UMD build creates an internal 814.ffmpeg.js
    // Worker. When ffmpeg.js is loaded from unpkg, that Worker is cross-origin
    // relative to the Vercel app and browsers reject it. Convert the Worker
    // itself to a blob URL so it is created from the app's own origin.
    const [coreURL, wasmURL, workerLoadURL] = await Promise.all([
      toBlobURL(`${CORE_BASE}/ffmpeg-core.js`, "text/javascript"),
      toBlobURL(`${CORE_BASE}/ffmpeg-core.wasm`, "application/wasm"),
      toBlobURL(`${BASE}/814.ffmpeg.js`, "text/javascript"),
    ]);

    const loadPromise = ffmpeg.load({ coreURL, wasmURL, workerLoadURL });
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("FFmpeg converter timed out while loading. Check CDN/network access.")), 45000)
    );
    await Promise.race([loadPromise, timeout]);
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
  onProgress?.({ stage: "converting", detail: "Encoding a clean MP4" });

  // Do NOT stream-copy MediaRecorder MP4. Chrome/Safari can produce fragmented
  // MP4 with track timing that plays correctly in a browser but is reported as
  // ~0.1s by Windows/Instagram. Re-encoding through ffmpeg forces a fresh MP4
  // timeline and writes a normal moov atom with deterministic duration.
  const args = [
    "-i", inputName,
    "-map", "0:v:0",
    "-map", "0:a:0?",
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "20",
    "-pix_fmt", "yuv420p",
    "-profile:v", "high",
    "-level", "4.1",
    "-c:a", "aac",
    "-b:a", "128k",
    "-ar", "48000",
    "-movflags", "+faststart",
  ];

  // The measured render duration is authoritative. Give ffmpeg a tiny tail
  // allowance so the last video frame/audio packet is not clipped.
  if (Number.isFinite(durationSeconds) && durationSeconds > 0) {
    args.push("-t", String(Math.max(3, durationSeconds + 0.05)));
  }

  args.push(outputName);

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
