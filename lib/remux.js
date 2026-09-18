/**
 * lib/remux.js — converts a browser recording into a clean MP4.
 *
 * MediaRecorder MP4 can contain fragmented timing metadata. Browser playback
 * may be correct while Windows/Instagram reports a tiny duration. FFmpeg
 * rebuilds the timeline and writes a normal MP4.
 */

const FFMPEG_VERSION = "0.12.10";
const CORE_VERSION = "0.12.10";
const BASE = `https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@${FFMPEG_VERSION}/dist/umd`;
const CORE_BASE = `https://cdn.jsdelivr.net/npm/@ffmpeg/core@${CORE_VERSION}/dist/umd`;

let ffmpegPromise = null;

async function loadFFmpegLibrary() {
  const url = `${BASE}/ffmpeg.js`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const res = await fetch(url, { signal: controller.signal, cache: "force-cache" });
    if (!res.ok) throw new Error(`Could not load FFmpeg library (${res.status}): ${url}`);
    let source = await res.text();

    // UMD 0.12.x normally discovers 814.ffmpeg.js relative to ffmpeg.js.
    // Patch that generated Worker URL so it uses the explicit Blob URL below.
    source = source.replace(
      "new URL(e.p+e.u(814),e.b)",
      "r.workerLoadURL"
    );

    const moduleUrl = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
    try {
      await import(moduleUrl);
    } finally {
      URL.revokeObjectURL(moduleUrl);
    }
  } catch (err) {
    if (err?.name === "AbortError") throw new Error(`Timed out loading FFmpeg library: ${url}`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function toBlobURL(url, type) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const res = await fetch(url, { signal: controller.signal, cache: "force-cache" });
    if (!res.ok) throw new Error(`Could not fetch FFmpeg asset (${res.status}): ${url}`);
    return URL.createObjectURL(new Blob([await res.arrayBuffer()], { type }));
  } catch (err) {
    if (err?.name === "AbortError") throw new Error(`Timed out loading FFmpeg asset: ${url}`);
    throw err;
  } finally {
    clearTimeout(timer);
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
