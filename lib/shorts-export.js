import { toInstagramMp4 } from "./remux.js";

export async function exportShort({
  sourceBlob, videoStart, videoEnd, musicBlob = null, musicStart = 0,
  musicMode = "trim", musicVolume = 1, originalVolume = 1, onProgress,
}) {
  if (typeof document === "undefined") throw new Error("Short export is only available in the browser.");
  if (!sourceBlob?.size) throw new Error("No source video is loaded.");

  const start = Math.max(0, Number(videoStart) || 0);
  const end = Math.max(start + 0.05, Number(videoEnd) || start);
  const duration = end - start;
  const video = document.createElement("video");
  const music = musicBlob ? document.createElement("audio") : null;
  const canvas = document.createElement("canvas");
  const sourceUrl = URL.createObjectURL(sourceBlob);
  const musicUrl = musicBlob ? URL.createObjectURL(musicBlob) : null;
  let audioContext = null;
  let raf = 0;

  try {
    video.src = sourceUrl;
    video.preload = "auto";
    video.playsInline = true;
    video.muted = false;
    video.volume = 1;
    if (music) { music.src = musicUrl; music.preload = "auto"; music.volume = 1; }

    await Promise.all([loadMetadata(video), music ? loadMetadata(music) : Promise.resolve()]);
    if (!video.videoWidth || !video.videoHeight) throw new Error("The uploaded video could not be decoded.");

    const sourceW = video.videoWidth, sourceH = video.videoHeight;
    const scale = Math.min(720 / sourceW, 1280 / sourceH);
    canvas.width = Math.max(2, Math.round(sourceW * scale));
    canvas.height = Math.max(2, Math.round(sourceH * scale));
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("Could not create the export canvas.");

    const stream = canvas.captureStream(30);
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;

    if (AudioContextClass) {
      audioContext = new AudioContextClass();
      if (audioContext.state === "suspended") await audioContext.resume();
      const destination = audioContext.createMediaStreamDestination();
      const videoSource = audioContext.createMediaElementSource(video);
      const videoGain = audioContext.createGain();
      videoGain.gain.value = Math.max(0, Math.min(1, Number(originalVolume) || 0));
      videoSource.connect(videoGain).connect(destination);

      if (music) {
        const musicSource = audioContext.createMediaElementSource(music);
        const musicGain = audioContext.createGain();
        musicGain.gain.value = Math.max(0, Math.min(1, Number(musicVolume) || 0));
        musicSource.connect(musicGain).connect(destination);
      }
      destination.stream.getAudioTracks().forEach((track) => stream.addTrack(track));
      if (music && musicMode === "loop") {
        music.addEventListener("ended", () => {
          music.currentTime = Math.min(Number(musicStart) || 0, Math.max(0, music.duration - 0.05));
          music.play().catch(() => {});
        });
      }
    } else if (Number(originalVolume) > 0 || musicBlob) {
      throw new Error("This browser cannot capture audio for Short export.");
    }

    const mimeType = chooseMime(Boolean(audioContext));
    let recorder;
    try {
      recorder = new MediaRecorder(stream, {
        mimeType: mimeType || undefined,
        videoBitsPerSecond: 5_000_000,
        audioBitsPerSecond: audioContext ? 128_000 : undefined,
      });
    } catch {
      recorder = new MediaRecorder(stream);
    }

    await seek(video, start);
    if (music) {
      const maxStart = Math.max(0, music.duration - 0.05);
      await seek(music, Math.min(Number(musicStart) || 0, maxStart));
    }

    const chunks = [];
    const finished = new Promise((resolve, reject) => {
      recorder.ondataavailable = e => { if (e.data?.size) chunks.push(e.data); };
      recorder.onerror = e => reject(e.error || new Error("Short recording failed."));
      recorder.onstop = () => {
        const blob = new Blob(chunks, { type: recorder.mimeType || mimeType || "video/webm" });
        if (!blob.size) reject(new Error("The recorder produced an empty file."));
        else resolve(blob);
      };
    });

    recorder.start(100);
    const started = performance.now();
    await video.play();
    if (music) await music.play().catch(() => {});

    await new Promise((resolve) => {
      const draw = () => {
        const elapsed = (performance.now() - started) / 1000;
        if (elapsed >= duration) {
          onProgress?.({ stage: "recording", ratio: 1 });
          if (recorder.state !== "inactive") recorder.stop();
          resolve();
          return;
        }
        const sw = video.videoWidth || canvas.width, sh = video.videoHeight || canvas.height;
        const ratio = Math.max(canvas.width / sw, canvas.height / sh);
        const dw = sw * ratio, dh = sh * ratio;
        ctx.fillStyle = "#000";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(video, (canvas.width - dw) / 2, (canvas.height - dh) / 2, dw, dh);
        onProgress?.({ stage: "recording", ratio: Math.min(.99, elapsed / duration) });
        raf = requestAnimationFrame(draw);
      };
      raf = requestAnimationFrame(draw);
    });

    const intermediate = await finished;
    onProgress?.({ stage: "converting", ratio: 0, detail: "Preparing MP4" });
    const result = await toInstagramMp4(intermediate, { durationSeconds: duration, onProgress });
    return result.blob;
  } finally {
    if (raf) cancelAnimationFrame(raf);
    video.pause(); music?.pause();
    await audioContext?.close?.().catch(() => {});
    video.removeAttribute("src"); music?.removeAttribute("src");
    video.load(); music?.load?.();
    URL.revokeObjectURL(sourceUrl); if (musicUrl) URL.revokeObjectURL(musicUrl);
  }
}

function chooseMime(withAudio) {
  // Prefer native MP4 on every device, including Android.
  // Desktop-mode Android previously appeared to work because it commonly
  // selected the browser's MP4 recorder path. Forcing WebM on normal mobile
  // Android created a guaranteed ffmpeg.wasm conversion step. If MP4 is
  // supported, it is already the final container and remux.js can fast-path
  // it without loading FFmpeg.
  const mp4 = withAudio
    ? ["video/mp4;codecs=avc1.42E01E,mp4a.40.2","video/mp4"]
    : ["video/mp4"];
  const webm = withAudio
    ? ["video/webm;codecs=vp9,opus","video/webm;codecs=vp8,opus","video/webm"]
    : ["video/webm;codecs=vp9","video/webm"];
  const candidates = [...mp4, ...webm];
  return typeof MediaRecorder !== "undefined" ? candidates.find(t => MediaRecorder.isTypeSupported(t)) || "" : "";
}

function loadMetadata(media) {
  return new Promise((resolve, reject) => {
    if (media.readyState >= 1 && Number.isFinite(media.duration)) return resolve();
    const ok = () => { cleanup(); resolve(); };
    const bad = () => { cleanup(); reject(new Error("Could not decode uploaded media.")); };
    const cleanup = () => { media.removeEventListener("loadedmetadata", ok); media.removeEventListener("error", bad); };
    media.addEventListener("loadedmetadata", ok, { once: true });
    media.addEventListener("error", bad, { once: true });
  });
}
function seek(media, time) {
  return new Promise((resolve, reject) => {
    const target = Math.max(0, Math.min(Number(time) || 0, Math.max(0, (media.duration || 0) - .04)));
    if (Math.abs((media.currentTime || 0) - target) < .02) return resolve();
    const ok = () => { cleanup(); resolve(); };
    const bad = () => { cleanup(); reject(new Error("Could not seek uploaded media.")); };
    const cleanup = () => { media.removeEventListener("seeked", ok); media.removeEventListener("error", bad); };
    media.addEventListener("seeked", ok, { once: true }); media.addEventListener("error", bad, { once: true });
    media.currentTime = target;
  });
}
