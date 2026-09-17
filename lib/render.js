/**
 * Browser-side reel renderer.
 *
 * Draws each scene onto a 1080x1920 canvas with a slow Ken Burns push,
 * a crossfade into the next scene, and animated caption text. The canvas is
 * captured with MediaRecorder, so the whole thing costs nothing to run — the
 * viewer's own machine does the encoding.
 */

export const W = 1080;
export const H = 1920;

const FADE = 0.45; // crossfade length in seconds
const SAFE_TOP = 260; // Instagram's own UI sits above this
const SAFE_BOTTOM = 420; // and below this

export function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Image failed to decode"));
    img.src = src;
  });
}

export function timeline(scenes) {
  let t = 0;
  const marks = scenes.map((s) => {
    const start = t;
    t += s.seconds;
    return { start, end: t, duration: s.seconds };
  });
  return { marks, total: t };
}

function easeInOut(x) {
  return x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2;
}

/** Draw an image to fill the frame, scaled and panned. */
function drawCover(ctx, img, scale, panX, panY, alpha) {
  const ratio = Math.max(W / img.width, H / img.height) * scale;
    const w = img.width * ratio;
  const h = img.height * ratio;
  const x = (W - w) / 2 + panX;
  const y = (H - h) / 2 + panY;

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.drawImage(img, x, y, w, h);
  ctx.restore();
}

function wrapLines(ctx, text, maxWidth) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";

  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = word;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function drawScrim(ctx, theme) {
  const top = ctx.createLinearGradient(0, 0, 0, 520);
  top.addColorStop(0, "rgba(0,0,0,0.55)");
  top.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = top;
  ctx.fillRect(0, 0, W, 520);

  const bottom = ctx.createLinearGradient(0, H, 0, H - 900);
  bottom.addColorStop(0, "rgba(0,0,0,0.82)");
  bottom.addColorStop(0.55, "rgba(0,0,0,0.42)");
  bottom.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = bottom;
  ctx.fillRect(0, H - 900, W, 900);

  if (theme.tint) {
    ctx.save();
    ctx.globalCompositeOperation = "soft-light";
    ctx.fillStyle = theme.tint;
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }
}

function drawCaption(ctx, text, progress, theme) {
  if (!text) return;

  const size = 82;
  ctx.font = `800 ${size}px ${theme.fontStack}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";

  const lines = wrapLines(ctx, text, W - 190);
  const lineHeight = size * 1.16;
  const blockHeight = lines.length * lineHeight;

  // Sit the block in the lower third but never inside Instagram's UI zone.
  const startY = H - SAFE_BOTTOM - blockHeight;

  const appear = easeInOut(Math.min(1, progress / 0.18));
  const lift = (1 - appear) * 34;

  ctx.save();
  ctx.globalAlpha = appear;
  ctx.translate(0, lift);

  lines.forEach((line, i) => {
    const y = startY + (i + 1) * lineHeight;

    // A soft dark pad behind the type keeps it legible over any image.
    const metrics = ctx.measureText(line);
    const padX = 30;
    const boxW = metrics.width + padX * 2;
    ctx.fillStyle = "rgba(6,20,22,0.46)";
    roundRect(ctx, (W - boxW) / 2, y - size * 0.86, boxW, lineHeight * 0.98, 18);
    ctx.fill();

    ctx.lineWidth = 12;
    ctx.strokeStyle = "rgba(0,0,0,0.5)";
    ctx.lineJoin = "round";
    ctx.strokeText(line, W / 2, y);

    ctx.fillStyle = theme.textColor;
    ctx.fillText(line, W / 2, y);
  });

  ctx.restore();
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawHook(ctx, hook, t, theme) {
  if (!hook || t > 2.6) return;

  const fade = t < 2.2 ? 1 : 1 - (t - 2.2) / 0.4;
  const size = 54;
  ctx.save();
  ctx.globalAlpha = Math.max(0, fade) * 0.96;
  ctx.font = `700 ${size}px ${theme.fontStack}`;
  ctx.textAlign = "center";

  const lines = wrapLines(ctx, hook, W - 220);
  lines.forEach((line, i) => {
    const y = SAFE_TOP + i * size * 1.2;
    ctx.fillStyle = theme.accent;
    ctx.lineWidth = 9;
    ctx.strokeStyle = "rgba(0,0,0,0.55)";
    ctx.lineJoin = "round";
    ctx.strokeText(line, W / 2, y);
    ctx.fillText(line, W / 2, y);
  });
  ctx.restore();
}

function drawHandle(ctx, handle, theme) {
  if (!handle) return;
  ctx.save();
  ctx.font = `600 38px ${theme.fontStack}`;
  ctx.textAlign = "center";
  ctx.globalAlpha = 0.82;
  ctx.fillStyle = "#ffffff";
  ctx.fillText(handle, W / 2, H - 250);
  ctx.restore();
}

function drawProgressBar(ctx, t, total, theme) {
  const y = H - 170;
  ctx.save();
  ctx.fillStyle = "rgba(255,255,255,0.22)";
  roundRect(ctx, 120, y, W - 240, 8, 4);
  ctx.fill();
  ctx.fillStyle = theme.accent;
  roundRect(ctx, 120, y, (W - 240) * Math.min(1, t / total), 8, 4);
  ctx.fill();
  ctx.restore();
}

/**
 * Draw a single frame at time `t`. Pure — safe to call for preview scrubbing
 * and for recording alike.
 */
export function drawFrame(ctx, t, { scenes, images, marks, total, hook, handle, theme }) {
  ctx.fillStyle = "#05161a";
  ctx.fillRect(0, 0, W, H);

  const index = marks.findIndex((m) => t >= m.start && t < m.end);
  const i = index === -1 ? marks.length - 1 : index;
  const mark = marks[i];
  const local = Math.max(0, Math.min(mark.duration, t - mark.start));
  const progress = local / mark.duration;

  // Ken Burns: alternate the direction per scene so it never feels mechanical.
  const dir = i % 2 === 0 ? 1 : -1;
  const scale = 1.04 + easeInOut(progress) * 0.12;
  const panX = dir * easeInOut(progress) * 46;
  const panY = -easeInOut(progress) * 40;

  if (images[i]) drawCover(ctx, images[i], scale, panX, panY, 1);

  // Crossfade the next scene in over the tail of this one.
  const tailLeft = mark.duration - local;
  if (tailLeft < FADE && images[i + 1]) {
    const k = 1 - tailLeft / FADE;
    const nextScale = 1.04 + k * 0.02;
    drawCover(ctx, images[i + 1], nextScale, 0, 0, easeInOut(k));
  }

  drawScrim(ctx, theme);
  drawCaption(ctx, scenes[i]?.onScreenText, progress, theme);
  drawHook(ctx, hook, t, theme);
  drawHandle(ctx, handle, theme);
  drawProgressBar(ctx, t, total, theme);
}

function pickMimeType() {
  const candidates = [
    "video/mp4;codecs=avc1.42E01E",
    "video/mp4;codecs=h264",
    "video/mp4",
    "video/webm;codecs=vp9",
    "video/webm;codecs=vp8",
    "video/webm",
  ];
  for (const type of candidates) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(type)) {
      return type;
    }
  }
  return "";
}

function createNoiseBuffer(ctx, seconds = 0.18) {
  const buffer = ctx.createBuffer(1, Math.floor(ctx.sampleRate * seconds), ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) {
    data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
  }
  return buffer;
}

function scheduleTone(ctx, destination, start, duration, frequency, type, volume) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(frequency, start);
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(volume, start + 0.03);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  osc.connect(gain).connect(destination);
  osc.start(start);
  osc.stop(start + duration + 0.02);
}

function scheduleNoiseHit(ctx, destination, start, volume) {
  const source = ctx.createBufferSource();
  const gain = ctx.createGain();
  const filter = ctx.createBiquadFilter();
  source.buffer = createNoiseBuffer(ctx);
  filter.type = "highpass";
  filter.frequency.setValueAtTime(900, start);
  gain.gain.setValueAtTime(volume, start);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.18);
  source.connect(filter).connect(gain).connect(destination);
  source.start(start);
}

function createAudioBed(state) {
  const AudioCtor = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtor) return null;

  const ctx = new AudioCtor();
  const destination = ctx.createMediaStreamDestination();
  const master = ctx.createGain();
  master.gain.value = state.soundVolume ?? 0.22;
  master.connect(destination);

  const now = ctx.currentTime + 0.12;
  const total = Math.max(1, state.total);
  const profile = state.soundProfile || "cinematic";
  const root = profile === "funny" ? 196 : profile === "news" ? 164 : profile === "fast" ? 220 : 146;
  const pulse = profile === "calm" || profile === "cinematic" ? 1.4 : 0.72;

  for (let t = 0; t < total; t += pulse) {
    const note = root * [1, 1.25, 1.5, 2][Math.floor(t / pulse) % 4];
    scheduleTone(ctx, master, now + t, Math.min(0.58, pulse * 0.82), note, profile === "funny" ? "square" : "sine", 0.035);
    if (profile === "fast" || profile === "viral") {
      scheduleTone(ctx, master, now + t, 0.08, 62, "triangle", 0.06);
    }
  }

  state.marks.forEach((mark, index) => {
    scheduleNoiseHit(ctx, master, now + mark.start, index === 0 ? 0.015 : 0.035);
    scheduleTone(ctx, master, now + mark.start + 0.02, 0.22, root * (1 + (index % 3) * 0.25), "triangle", 0.028);
  });

  return { ctx, stream: destination.stream, offset: 0.12 };
}

/**
 * Render and record the whole reel. Resolves with a Blob plus the file
 * extension the browser actually produced.
 */
export function recordReel(canvas, state, onProgress) {
  return new Promise((resolve, reject) => {
    const ctx = canvas.getContext("2d", { alpha: false });
    const fps = 30;
    const stream = canvas.captureStream(fps);
    const audio = state.soundEnabled ? createAudioBed(state) : null;
    if (audio?.stream?.getAudioTracks()?.[0]) {
      stream.addTrack(audio.stream.getAudioTracks()[0]);
    }
    const mimeType = pickMimeType();

    let recorder;
    try {
      recorder = new MediaRecorder(stream, {
        mimeType: mimeType || undefined,
        videoBitsPerSecond: 8_000_000,
      });
    } catch (err) {
      reject(new Error(`This browser cannot record canvas video: ${err.message}`));
      return;
    }

    const chunks = [];
    recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    recorder.onerror = (e) => reject(e.error || new Error("Recording failed"));

    recorder.onstop = () => {
      audio?.ctx?.close?.();
      const type = recorder.mimeType || mimeType || "video/webm";
      const ext = type.includes("mp4") ? "mp4" : "webm";
      resolve({ blob: new Blob(chunks, { type }), ext, mimeType: type });
    };

    const start = performance.now();
    recorder.start(200);

    function tick() {
      const t = (performance.now() - start) / 1000;

      if (t >= state.total) {
        drawFrame(ctx, state.total - 0.001, state);
        onProgress?.(1);
        // Give the encoder a beat to flush the final frames.
        setTimeout(() => recorder.state !== "inactive" && recorder.stop(), 260);
        return;
      }

      drawFrame(ctx, t, state);
      onProgress?.(t / state.total);
      requestAnimationFrame(tick);
    }

    requestAnimationFrame(tick);
  });
}

export const THEMES = {
  bold: { fontStack: '"Bricolage Grotesque", Impact, sans-serif', textColor: "#FFFFFF", accent: "#F5B13C", tint: null },
  warm: { fontStack: '"Bricolage Grotesque", Georgia, serif', textColor: "#FFF3E0", accent: "#FF8A5B", tint: "rgba(255,160,80,0.10)" },
  cool: { fontStack: '"Instrument Sans", Helvetica, sans-serif', textColor: "#EAF7FF", accent: "#63D2C8", tint: "rgba(70,190,220,0.10)" },
  mono: { fontStack: '"Instrument Sans", Helvetica, sans-serif', textColor: "#FFFFFF", accent: "#FFFFFF", tint: "rgba(0,0,0,0.05)" },
};
