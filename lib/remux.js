/**
 * lib/remux.js — export pipeline, rebuilt around one idea: ffmpeg is the
 * expensive path, so only take it when nothing else will do.
 *
 * DECISION TREE (the answer to the "A through F" design question):
 *
 *   1. Sniff the actual bytes (lib/container-sniff.js), not the declared
 *      mime type. If it's already MP4 with a usable duration — either the
 *      browser produced a non-fragmented file, or lib/mp4-duration.js
 *      already patched it — DONE. No ffmpeg load, no transcode, no wait.
 *      This is option (A), and it should cover most desktop recordings and,
 *      per the note at the bottom of this file, possibly Android too.
 *
 *   2. If it's a fragmented MP4 with duration still zero, run it through
 *      fixMp4Duration first (near-instant, in lib/mp4-duration.js) and
 *      re-check. Often that alone is enough.
 *
 *   3. Only if the container is genuinely WebM, or the MP4 is structurally
 *      broken beyond a header patch, fall through to ffmpeg.wasm — option
 *      (C) — because WebM's VP9/Opus payload has to be decoded and
 *      re-encoded to H.264/AAC; there's no valid stream-copy from VP9 into
 *      something Instagram accepts.
 *
 *   (B) — WebM + lightweight repair only — doesn't reach Instagram
 *   compatibility on its own: the container would be valid but the codec
 *   (VP9/Opus) still isn't what Instagram's uploader expects. (D) WebCodecs
 *   would be the fastest transcode path where available, but browser
 *   support for encoding AAC via WebCodecs is not yet consistent enough to
 *   rely on as of this writing — worth revisiting. (E) server-side
 *   conversion is deliberately avoided everywhere else in this app; adding
 *   a server hop here would undercut the whole "zero server cost" design.
 *   (F) is what this file *is* — capability detection choosing between A/C.
 *
 * SPEED, for when step 3 is unavoidable:
 *   - The ~32MB core is preloaded during idle time (see preloadFFmpeg),
 *     not on the user's download click.
 *   - Multi-threaded core when the page is cross-origin isolated (needs the
 *     COOP/COEP headers in next.config.mjs), single-threaded fallback
 *     otherwise. This is the single biggest lever on a multi-core phone.
 *   - No ffprobe call anywhere. @ffmpeg/ffmpeg 0.12.x never implemented one
 *     — the npm package only exposes exec/writeFile/readFile/deleteFile/
 *     listDir/on. A call to .ffprobe() will always throw, on any build; it
 *     needs deleting, not supporting. Duration is already known precisely
 *     from the JS recording timer — nothing needs probing.
 *
 * SYNC, for the transcode path:
 *   The output is force-aligned to the authored duration regardless of
 *   which input stream came up short, using `tpad` (holds the last video
 *   frame) and `apad` (silence-pads audio) plus a hard `-t` cap. This
 *   guarantees a correctly-timed file even if the source recording itself
 *   has a genuine video/audio length mismatch — see the note at the bottom
 *   about where that mismatch likely originates.
 */

import { sniffContainer, mp4HasUsableDuration } from "./container-sniff.js";
import { fixMp4Duration } from "./mp4-duration.js";

const FFMPEG_VERSION = "0.12.10";
const CORE_VERSION = "0.12.10";
const CORE_ST = `https://cdn.jsdelivr.net/npm/@ffmpeg/core@${CORE_VERSION}/dist/umd`;
const CORE_MT = `https://cdn.jsdelivr.net/npm/@ffmpeg/core-mt@${CORE_VERSION}/dist/umd`;

let ffmpegPromise = null;
let preloadStarted = false;

function isCrossOriginIsolated() {
  return typeof self !== "undefined" && self.crossOriginIsolated === true;
}

async function toBlobURL(url, type) {
  const res = await fetch(url, { mode: "cors" });
  if (!res.ok) throw new Error(`Could not fetch ${url} (${res.status})`);
  const blob = new Blob([await res.arrayBuffer()], { type });
  return URL.createObjectURL(blob);
}

/**
 * IMPORTANT: load @ffmpeg/ffmpeg from the app bundle, not a CDN.
 *
 * The UMD build on unpkg/jsdelivr contains a generated async worker chunk
 * (814.ffmpeg.js). A page on creatorflow-ai-five.vercel.app cannot construct
 * a Worker directly from that third-party origin, which is exactly the
 * mobile error:
 *   Failed to construct 'Worker' ... 814.ffmpeg.js ... cannot be accessed
 *
 * A bundled ESM import lets Next.js package worker.js as a same-origin
 * application asset. The FFmpeg core/wasm are then fetched as bytes and
 * converted to same-origin Blob URLs, following the official ffmpeg.wasm
 * loading pattern and avoiding the cross-origin worker problem.
 */
async function loadFFmpeg(onProgress) {
  if (ffmpegPromise) return ffmpegPromise;

  ffmpegPromise = (async () => {
    const mt = isCrossOriginIsolated();
    onProgress?.({
      stage: "loading",
      detail: mt ? "Loading the converter (multi-threaded)" : "Loading the converter",
    });

    // This dynamic import is intentionally a literal package import so the
    // Next.js bundler owns the worker asset. Never replace this with a CDN
    // <script> or runtime import(blobURL).
    const { FFmpeg } = await import("@ffmpeg/ffmpeg");
    const ffmpeg = new FFmpeg();
    const coreBase = mt ? CORE_MT : CORE_ST;

    try {
      const [coreURL, wasmURL] = await Promise.all([
        toBlobURL(`${coreBase}/ffmpeg-core.js`, "text/javascript"),
        toBlobURL(`${coreBase}/ffmpeg-core.wasm`, "application/wasm"),
      ]);
      await ffmpeg.load({ coreURL, wasmURL });
    } catch (err) {
      if (!mt) throw err;
      onProgress?.({ stage: "loading", detail: "Falling back to the single-threaded converter" });
      const [coreURL, wasmURL] = await Promise.all([
        toBlobURL(`${CORE_ST}/ffmpeg-core.js`, "text/javascript"),
        toBlobURL(`${CORE_ST}/ffmpeg-core.wasm`, "application/wasm"),
      ]);
      await ffmpeg.load({ coreURL, wasmURL });
    }

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
 * Call once, early — e.g. right after the app mounts, or right after a
 * render finishes — so the ~32MB fetch is done before anyone clicks
 * Download. Safe to call more than once; only the first call does anything.
 * Never throws: a failed preload just means the real attempt loads it fresh.
 */
export function preloadFFmpeg() {
  if (preloadStarted || typeof window === "undefined") return;
  preloadStarted = true;

  const start = () => loadFFmpeg().catch(() => {
    // Preload failing silently is fine; the export button will try again
    // and surface any real error then.
  });

  if ("requestIdleCallback" in window) {
    window.requestIdleCallback(start, { timeout: 8000 });
  } else {
    setTimeout(start, 2500);
  }
}

/**
 * @param {Blob} blob             recording straight from MediaRecorder
 * @param {number} durationMs     real length, measured by the JS timer
 * @param {function} [onProgress]
 * @returns {Promise<{blob: Blob, usedFfmpeg: boolean}>}
 */
export async function toInstagramMp4(blob, { durationSeconds, onProgress } = {}) {
  if (!blob || blob.size === 0) throw new Error("The recording is empty.");

  const headBytes = new Uint8Array(await blob.slice(0, 65536).arrayBuffer());
  const kind = sniffContainer(headBytes);

  if (kind === "unknown") {
    throw new Error(
      "This file isn't a recognisable video container. Re-record rather than trying to convert it."
    );
  }

  const durationMs = Math.round((durationSeconds || 0) * 1000);

  // ── fast path: already MP4 ──────────────────────────────
  if (kind === "mp4") {
    if (mp4HasUsableDuration(headBytes)) {
      onProgress?.({ stage: "done", ratio: 1, detail: "Already a valid MP4" });
      return { blob, usedFfmpeg: false };
    }

    // Fragmented MP4 with duration still zero — the header patch alone
    // usually fixes it, at essentially zero cost. Try that before ever
    // touching ffmpeg.
    onProgress?.({ stage: "converting", ratio: 0.3, detail: "Repairing the file header" });
    const patched = await fixMp4Duration(blob, durationMs);
    const patchedHead = new Uint8Array(await patched.slice(0, 65536).arrayBuffer());

    if (mp4HasUsableDuration(patchedHead)) {
      onProgress?.({ stage: "done", ratio: 1, detail: "Fixed" });
      return { blob: patched, usedFfmpeg: false };
    }
    // Header patch didn't take — genuinely malformed. Fall through to a
    // full ffmpeg remux below rather than shipping a broken file.
  }

  // ── transcode path ───────────────────────────────────────
  const ffmpeg = await loadFFmpeg(onProgress);

  const inputName = kind === "webm" ? "in.webm" : "in.mp4";
  const outputName = "out.mp4";

  let sawProgress = false;
  const progressHandler = ({ progress }) => {
    if (Number.isFinite(progress) && progress >= 0) {
      sawProgress = true;
      onProgress?.({ stage: "converting", ratio: Math.max(0, Math.min(1, progress)) });
    }
  };
  ffmpeg.on?.("progress", progressHandler);
  if (!sawProgress) onProgress?.({ stage: "converting", detail: "Converting" });

  await ffmpeg.writeFile(inputName, new Uint8Array(await blob.arrayBuffer()));

  const target = durationSeconds > 0 ? durationSeconds : null;

  // tpad holds the last video frame to fill any gap; apad silences-fills
  // audio the same way. Combined with a hard -t cap, the output always
  // lands exactly on the authored duration regardless of which source
  // stream came up short — see the file-level note on where that
  // mismatch most likely originates.
  const filters = target
    ? ["-vf", `tpad=stop_mode=clone:stop_duration=${target}`, "-af", `apad=whole_dur=${target}`]
    : [];

  const args = [
    "-i", inputName,
    ...filters,
    "-c:v", "libx264",
    "-preset", "ultrafast",
    "-crf", "26",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-b:a", "128k",
    "-ar", "48000",
    "-movflags", "+faststart",
    ...(target ? ["-t", String(target)] : []),
    outputName,
  ];

  try {
    await ffmpeg.exec(args);
  } finally {
    ffmpeg.off?.("progress", progressHandler);
  }

  const data = await ffmpeg.readFile(outputName);
  await ffmpeg.deleteFile(inputName).catch(() => {});
  await ffmpeg.deleteFile(outputName).catch(() => {});

  const outBytes = data.buffer ? new Uint8Array(data.buffer) : new Uint8Array(data);
  if (outBytes.length === 0) throw new Error("Conversion produced an empty file.");

  // Verify the actual bytes before handing this back as "done" — the one
  // hard rule from the brief is that a WebM never goes out the door
  // wearing an .mp4 label.
  const outKind = sniffContainer(outBytes.slice(0, 65536));
  if (outKind !== "mp4") {
    throw new Error(`Conversion did not produce a valid MP4 (detected: ${outKind}).`);
  }

  const out = new Blob([outBytes], { type: "video/mp4" });
  onProgress?.({ stage: "done", ratio: 1 });
  return { blob: out, usedFfmpeg: true };
}

/**
 * Cheap, synchronous, no network: is this blob already something Instagram
 * will accept as-is, purely by container/mime? Used to decide whether to
 * show a "Convert" affordance at all. Does NOT guarantee the duration is
 * populated — call toInstagramMp4 to get (and verify) that.
 */
export function looksInstagramReady(mimeType) {
  return /mp4/i.test(mimeType || "");
}

/**
 * ROOT-CAUSE NOTE — the video/audio length mismatch (observed: ~3.8s of
 * video content inside an ~8.5s container).
 *
 * This file cannot fix that at the source; it can only guarantee the
 * *exported* file is correctly aligned (via tpad/apad above), which is a
 * legitimate and sufficient fix for Instagram compatibility, but the
 * underlying cause is still worth chasing down in lib/render.js, because a
 * reel that's mostly a frozen last frame for 4+ seconds is a bad reel even
 * once it's technically valid.
 *
 * The most likely explanation, without device access to confirm: canvas
 * `captureStream(fps)` in continuous mode should keep emitting frames at
 * the requested rate for as long as the track runs, independent of how
 * often your draw loop actually redraws the canvas — but MediaRecorder
 * itself records real wall-clock time from `.start()` to `.stop()`. If
 * something delays *when your own code calls `.stop()`* — most plausibly
 * `requestAnimationFrame` being throttled on Android while the tab is
 * backgrounded, or heavy main-thread work from the Web Audio synthesis
 * blocking the draw loop — the video track would end up covering *more*
 * wall-clock time than intended, not less, which doesn't match what was
 * observed. A mismatch in the other direction (video shorter than audio)
 * is more consistent with the video track being stopped or the canvas
 * being paused early relative to the audio graph, which runs on its own
 * independent clock once scheduled. Worth adding a one-line log of
 * `videoTrack.getSettings()` frame count vs `performance.now()` elapsed at
 * the moment `.stop()` is called, on an affected Android device, before
 * changing anything in the capture loop itself.
 */
