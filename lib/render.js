/**
 * lib/render.js — browser reel compositor.
 *
 * What changed from the previous version:
 *  - Eight transitions instead of one crossfade, picked per cut from a seed.
 *  - Seven camera moves instead of one Ken Burns push, with optional handheld
 *    shake layered on top.
 *  - Five caption animations, timed to the beat of the generated score.
 *  - Grain, vignette and a drifting light leak, so flat AI stills stop looking
 *    like flat AI stills.
 *  - The score from lib/audio.js is mixed into the MediaRecorder stream, and
 *    scene cuts are passed to it so whooshes land on the cut.
 *
 * Exported API is unchanged: W, H, loadImage, timeline, drawFrame, recordReel,
 * THEMES. State gains optional fields, all with defaults.
 */

import { buildScore, pickGenre } from "./audio.js";
import { fixWebmDuration } from "./webm-duration.js";

export const W = 1080;
export const H = 1920;

const SAFE_TOP = 250;
const SAFE_BOTTOM = 430;

/* ── helpers ───────────────────────────────────────────── */

function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const easeInOut = (x) => (x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2);
const easeOut = (x) => 1 - Math.pow(1 - x, 3);
const easeOutBack = (x) => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
};
const clamp01 = (x) => Math.max(0, Math.min(1, x));

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
    const duration = Math.min(7, Math.max(1.8, Number(s.seconds) || 3.5));
    t += duration;
    return { start, end: t, duration };
  });
  return { marks, total: t };
}

/* ── camera moves ──────────────────────────────────────── */

const MOVES = {
  pushIn: (p) => ({ scale: 1.04 + easeInOut(p) * 0.18, x: 0, y: -easeInOut(p) * 26, rot: 0 }),
  pullOut: (p) => ({ scale: 1.26 - easeInOut(p) * 0.18, x: 0, y: easeInOut(p) * 22, rot: 0 }),
  panRight: (p) => ({ scale: 1.2, x: (easeInOut(p) - 0.5) * 150, y: 0, rot: 0 }),
  panLeft: (p) => ({ scale: 1.2, x: -(easeInOut(p) - 0.5) * 150, y: 0, rot: 0 }),
  tiltUp: (p) => ({ scale: 1.22, x: 0, y: (easeInOut(p) - 0.5) * 190, rot: 0 }),
  tiltDown: (p) => ({ scale: 1.22, x: 0, y: -(easeInOut(p) - 0.5) * 190, rot: 0 }),
  driftRotate: (p) => ({
    scale: 1.1 + easeInOut(p) * 0.12,
    x: (easeInOut(p) - 0.5) * 48,
    y: (easeInOut(p) - 0.5) * -40,
    rot: (easeInOut(p) - 0.5) * 0.022,
  }),
};

const MOVE_KEYS = Object.keys(MOVES);

/** Draw an image to cover the frame with a transform applied. */
function drawCover(ctx, img, { scale = 1, x = 0, y = 0, rot = 0, alpha = 1, blur = 0 }) {
  if (!img || alpha <= 0.002) return;

  const ratio = Math.max(W / img.width, H / img.height) * scale;
  const w = img.width * ratio;
  const h = img.height * ratio;

  ctx.save();
  ctx.globalAlpha = alpha;
  if (blur > 0.4 && "filter" in ctx) ctx.filter = `blur(${blur}px)`;
  if (rot) {
    ctx.translate(W / 2, H / 2);
    ctx.rotate(rot);
    ctx.translate(-W / 2, -H / 2);
  }
  ctx.drawImage(img, (W - w) / 2 + x, (H - h) / 2 + y, w, h);
  ctx.restore();
}

/* ── transitions ───────────────────────────────────────── */
/* Each receives k from 0 to 1 and draws both the outgoing and incoming frame. */

const TRANSITIONS = {
  fade(ctx, { from, to, k, fromT, toT }) {
    drawCover(ctx, from, { ...fromT, alpha: 1 });
    drawCover(ctx, to, { ...toT, alpha: easeInOut(k) });
  },

  whipLeft(ctx, { from, to, k, fromT, toT }) {
    const e = easeInOut(k);
    const blur = Math.sin(k * Math.PI) * 26;
    drawCover(ctx, from, { ...fromT, x: fromT.x - e * W * 1.05, alpha: 1, blur });
    drawCover(ctx, to, { ...toT, x: toT.x + (1 - e) * W * 1.05, alpha: 1, blur });
  },

  whipRight(ctx, { from, to, k, fromT, toT }) {
    const e = easeInOut(k);
    const blur = Math.sin(k * Math.PI) * 26;
    drawCover(ctx, from, { ...fromT, x: fromT.x + e * W * 1.05, alpha: 1, blur });
    drawCover(ctx, to, { ...toT, x: toT.x - (1 - e) * W * 1.05, alpha: 1, blur });
  },

  zoomPunch(ctx, { from, to, k, fromT, toT }) {
    const e = easeOut(k);
    drawCover(ctx, from, {
      ...fromT,
      scale: fromT.scale * (1 + e * 0.5),
      alpha: 1 - e,
      blur: e * 14,
    });
    drawCover(ctx, to, { ...toT, scale: toT.scale * (1.42 - e * 0.42), alpha: e });
  },

  slideUp(ctx, { from, to, k, fromT, toT }) {
    const e = easeInOut(k);
    drawCover(ctx, from, { ...fromT, y: fromT.y - e * H * 0.42, alpha: 1 - e * 0.35 });
    drawCover(ctx, to, { ...toT, y: toT.y + (1 - e) * H, alpha: 1 });
  },

  wipeDiagonal(ctx, { from, to, k, fromT, toT }) {
    drawCover(ctx, from, { ...fromT, alpha: 1 });
    const e = easeInOut(k);
    ctx.save();
    ctx.beginPath();
    const reach = (W + H) * e;
    ctx.moveTo(-200, -200);
    ctx.lineTo(-200 + reach, -200);
    ctx.lineTo(-200, -200 + reach);
    ctx.closePath();
    ctx.clip();
    drawCover(ctx, to, { ...toT, alpha: 1 });
    ctx.restore();
  },

  blurDissolve(ctx, { from, to, k, fromT, toT }) {
    const bell = Math.sin(k * Math.PI);
    drawCover(ctx, from, { ...fromT, alpha: 1, blur: bell * 22 });
    drawCover(ctx, to, { ...toT, alpha: easeInOut(k), blur: bell * 22 });
  },

  /** Horizontal slice offsets plus an RGB split. Use sparingly. */
  glitch(ctx, { from, to, k, fromT, toT, rand }) {
    const e = easeInOut(k);
    drawCover(ctx, from, { ...fromT, alpha: 1 - e });

    const slices = 9;
    const sliceH = H / slices;
    ctx.save();
    ctx.globalAlpha = e;
    for (let i = 0; i < slices; i++) {
      const jitter = (rand(i) - 0.5) * 130 * Math.sin(k * Math.PI);
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, i * sliceH, W, sliceH + 1);
      ctx.clip();
      drawCover(ctx, to, { ...toT, x: toT.x + jitter, alpha: 1 });
      ctx.restore();
    }
    ctx.restore();

    if (k > 0.15 && k < 0.85) {
      ctx.save();
      ctx.globalCompositeOperation = "screen";
      ctx.globalAlpha = 0.16 * Math.sin(k * Math.PI);
      ctx.fillStyle = "#ff0044";
      ctx.fillRect(-8, 0, W, H);
      ctx.fillStyle = "#00ffee";
      ctx.fillRect(8, 0, W, H);
      ctx.restore();
    }
  },
};

const TRANSITION_KEYS = Object.keys(TRANSITIONS);

/** Which transitions suit which mood. Glitch never fires on calm content. */
const TRANSITION_SETS = {
  energetic: ["whipLeft", "whipRight", "zoomPunch", "glitch", "slideUp", "wipeDiagonal"],
  balanced: ["whipLeft", "whipRight", "zoomPunch", "slideUp", "fade", "blurDissolve"],
  calm: ["fade", "blurDissolve", "slideUp", "wipeDiagonal"],
};

/* ── caption animations ────────────────────────────────── */

const CAPTION_STYLES = ["popIn", "wordReveal", "slideUp", "typewriter", "sweep"];

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

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function fitFont(ctx, text, theme, maxWidth, maxLines) {
  // Shrink until the caption fits, so a long line never runs off the frame.
  for (let size = 92; size >= 46; size -= 4) {
    ctx.font = `800 ${size}px ${theme.fontStack}`;
    const lines = wrapLines(ctx, text, maxWidth);
    if (lines.length <= maxLines) return { size, lines };
  }
  ctx.font = `800 46px ${theme.fontStack}`;
  return { size: 46, lines: wrapLines(ctx, text, maxWidth) };
}

function drawCaption(ctx, text, local, duration, theme, style, beat) {
  if (!text) return;

  const maxWidth = W - 180;
  const { size, lines } = fitFont(ctx, text, theme, maxWidth, 4);
  const lineHeight = size * 1.15;
  const blockHeight = lines.length * lineHeight;
  const startY = H - SAFE_BOTTOM - blockHeight;

  // Animate in over roughly one beat, out over the last third of a beat.
  const inDur = Math.min(0.55, beat * 0.9);
  const enter = clamp01(local / inDur);
  const exit = clamp01((duration - local) / 0.3);

  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";

  lines.forEach((line, i) => {
    const y = startY + (i + 1) * lineHeight;
    const stagger = clamp01((local - i * 0.075) / inDur);

    let alpha = Math.min(stagger, exit);
    let offsetY = 0;
    let scale = 1;
    let visible = line;

    if (style === "popIn") {
      scale = 0.82 + easeOutBack(stagger) * 0.18;
    } else if (style === "slideUp") {
      offsetY = (1 - easeOut(stagger)) * 46;
    } else if (style === "typewriter") {
      const chars = Math.ceil(line.length * clamp01(local / (inDur * 1.7)));
      visible = line.slice(0, chars);
      alpha = exit;
    } else if (style === "wordReveal") {
      const words = line.split(" ");
      const shown = Math.ceil(words.length * clamp01(local / (inDur * 1.4)));
      visible = words.slice(0, shown).join(" ");
      alpha = exit;
    }

    if (!visible) return;

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.font = `800 ${size}px ${theme.fontStack}`;

    if (scale !== 1) {
      ctx.translate(W / 2, y - size * 0.35);
      ctx.scale(scale, scale);
      ctx.translate(-W / 2, -(y - size * 0.35));
    }

    const metrics = ctx.measureText(visible);

    if (style === "sweep") {
      // An accent bar wipes in behind the type.
      const barW = (metrics.width + 56) * easeOut(stagger);
      ctx.fillStyle = theme.accent;
      ctx.globalAlpha = alpha * 0.9;
      roundRect(ctx, W / 2 - (metrics.width + 56) / 2, y - size * 0.88, barW, lineHeight * 0.96, 12);
      ctx.fill();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = "#12100c";
      ctx.fillText(visible, W / 2, y + offsetY);
      ctx.restore();
      return;
    }

    const padX = 28;
    const boxW = metrics.width + padX * 2;
    ctx.fillStyle = "rgba(6,18,20,0.44)";
    roundRect(ctx, (W - boxW) / 2, y - size * 0.85 + offsetY, boxW, lineHeight * 0.97, 16);
    ctx.fill();

    ctx.lineWidth = Math.max(9, size * 0.14);
    ctx.strokeStyle = "rgba(0,0,0,0.55)";
    ctx.lineJoin = "round";
    ctx.miterLimit = 2;
    ctx.strokeText(visible, W / 2, y + offsetY);

    ctx.fillStyle = theme.textColor;
    ctx.fillText(visible, W / 2, y + offsetY);
    ctx.restore();
  });
}

/* ── overlays ──────────────────────────────────────────── */

let grainTile = null;

function getGrainTile() {
  if (grainTile || typeof document === "undefined") return grainTile;
  const c = document.createElement("canvas");
  c.width = 220;
  c.height = 220;
  const g = c.getContext("2d");
  const data = g.createImageData(220, 220);
  for (let i = 0; i < data.data.length; i += 4) {
    const v = 110 + Math.random() * 90;
    data.data[i] = data.data[i + 1] = data.data[i + 2] = v;
    data.data[i + 3] = 255;
  }
  g.putImageData(data, 0, 0);
  grainTile = c;
  return grainTile;
}

function drawGrain(ctx, t, amount) {
  const tile = getGrainTile();
  if (!tile || amount <= 0) return;
  ctx.save();
  ctx.globalCompositeOperation = "overlay";
  ctx.globalAlpha = amount;
  const ox = -((t * 900) % 220);
  const oy = -((t * 1370) % 220);
  for (let x = ox; x < W; x += 220) {
    for (let y = oy; y < H; y += 220) ctx.drawImage(tile, x, y);
  }
  ctx.restore();
}

function drawVignette(ctx, strength) {
  const grad = ctx.createRadialGradient(W / 2, H / 2, H * 0.28, W / 2, H / 2, H * 0.72);
  grad.addColorStop(0, "rgba(0,0,0,0)");
  grad.addColorStop(1, `rgba(0,0,0,${strength})`);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);
}

function drawLightLeak(ctx, t, theme, seed) {
  const drift = Math.sin(t * 0.34 + seed) * 0.5 + 0.5;
  const cx = W * (0.15 + drift * 0.7);
  const cy = H * (0.18 + Math.cos(t * 0.27 + seed) * 0.12);
  const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, W * 0.85);
  grad.addColorStop(0, theme.leak || "rgba(255,190,120,0.16)");
  grad.addColorStop(1, "rgba(0,0,0,0)");
  ctx.save();
  ctx.globalCompositeOperation = "screen";
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);
  ctx.restore();
}

function drawScrim(ctx, theme) {
  const top = ctx.createLinearGradient(0, 0, 0, 480);
  top.addColorStop(0, "rgba(0,0,0,0.5)");
  top.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = top;
  ctx.fillRect(0, 0, W, 480);

  const bottom = ctx.createLinearGradient(0, H, 0, H - 950);
  bottom.addColorStop(0, "rgba(0,0,0,0.85)");
  bottom.addColorStop(0.5, "rgba(0,0,0,0.44)");
  bottom.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = bottom;
  ctx.fillRect(0, H - 950, W, 950);

  if (theme.tint) {
    ctx.save();
    ctx.globalCompositeOperation = "soft-light";
    ctx.fillStyle = theme.tint;
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }
}

function drawHook(ctx, hook, t, theme, beat) {
  if (!hook || t > 2.8) return;
  const appear = clamp01(t / (beat * 0.8));
  const fade = t < 2.3 ? 1 : 1 - (t - 2.3) / 0.5;
  const alpha = Math.max(0, Math.min(appear, fade));
  if (alpha <= 0) return;

  const size = 52;
  ctx.save();
  ctx.globalAlpha = alpha * 0.97;
  ctx.font = `700 ${size}px ${theme.fontStack}`;
  ctx.textAlign = "center";
  const lines = wrapLines(ctx, hook, W - 210);
  lines.forEach((line, i) => {
    const y = SAFE_TOP + i * size * 1.2 - (1 - easeOut(appear)) * 22;
    ctx.lineWidth = 9;
    ctx.strokeStyle = "rgba(0,0,0,0.6)";
    ctx.lineJoin = "round";
    ctx.strokeText(line, W / 2, y);
    ctx.fillStyle = theme.accent;
    ctx.fillText(line, W / 2, y);
  });
  ctx.restore();
}

function drawHandle(ctx, handle, theme) {
  if (!handle) return;
  ctx.save();
  ctx.font = `600 36px ${theme.fontStack}`;
  ctx.textAlign = "center";
  ctx.globalAlpha = 0.8;
  ctx.fillStyle = "#ffffff";
  ctx.fillText(handle, W / 2, H - 245);
  ctx.restore();
}

function drawProgressBar(ctx, t, total, theme) {
  const y = H - 168;
  ctx.save();
  ctx.fillStyle = "rgba(255,255,255,0.2)";
  roundRect(ctx, 120, y, W - 240, 8, 4);
  ctx.fill();
  ctx.fillStyle = theme.accent;
  roundRect(ctx, 120, y, (W - 240) * clamp01(t / total), 8, 4);
  ctx.fill();
  ctx.restore();
}

/* ── per-render effect plan ────────────────────────────── */

/**
 * Decide, once per reel, which move and transition each scene gets. Seeded, so
 * the same reel re-renders identically, but two reels never match. Consecutive
 * scenes never reuse the same move or transition.
 */
export function buildEffectPlan({ sceneCount, seed = Date.now(), mood = "balanced", bpm = 100 }) {
  const rand = mulberry32(seed);
  const pool = TRANSITION_SETS[mood] || TRANSITION_SETS.balanced;

  const moves = [];
  const transitions = [];
  const captions = [];

  for (let i = 0; i < sceneCount; i++) {
    const previousMove = i > 0 ? moves[i - 1].name : null;
    let move;
    let guard = 0;
    do {
      move = MOVE_KEYS[Math.floor(rand() * MOVE_KEYS.length)];
      guard++;
    } while (guard < 12 && move === previousMove);

    // Handheld shake on a minority of scenes only.
    moves.push({ name: move, handheld: rand() < 0.35, seed: Math.floor(rand() * 1e6) });

    let caption;
    guard = 0;
    do {
      caption = CAPTION_STYLES[Math.floor(rand() * CAPTION_STYLES.length)];
      guard++;
    } while (guard < 12 && caption === captions[i - 1]);
    captions.push(caption);

    if (i > 0) {
      const previousTransition = transitions[transitions.length - 1];
      let tr;
      guard = 0;
      do {
        tr = pool[Math.floor(rand() * pool.length)];
        guard++;
      } while (guard < 12 && tr === previousTransition);
      transitions.push(tr);
    }
  }

  return {
    moves,
    transitions,
    captions,
    grain: 0.05 + rand() * 0.05,
    vignette: 0.28 + rand() * 0.16,
    leak: rand() < 0.55,
    leakSeed: rand() * 6.28,
    transitionLength: 0.42,
    beat: 60 / bpm,
    rand,
  };
}

function transformFor(fx, index, p, t) {
  const cfg = fx.moves[index] || { name: "pushIn", handheld: false, seed: 0 };
  const base = (MOVES[cfg.name] || MOVES.pushIn)(p);

  if (cfg.handheld) {
    const s = cfg.seed * 0.001;
    base.x += Math.sin(t * 6.1 + s) * 5.5 + Math.sin(t * 11.3 + s) * 2.2;
    base.y += Math.cos(t * 5.3 + s) * 5 + Math.cos(t * 9.7 + s) * 1.8;
    base.rot += Math.sin(t * 3.7 + s) * 0.0018;
  }

  return { ...base, alpha: 1, blur: 0 };
}

/* ── the frame ─────────────────────────────────────────── */

export function drawFrame(ctx, t, state) {
  const { scenes, images, marks, total, hook, handle, theme } = state;

  // Build the effect plan lazily so existing callers need no changes.
  if (!state.fx) {
    state.fx = buildEffectPlan({
      sceneCount: scenes.length,
      seed: state.seed || Date.now(),
      mood: state.mood || "balanced",
      bpm: state.bpm || 100,
    });
  }
  const fx = state.fx;

  ctx.fillStyle = "#04141a";
  ctx.fillRect(0, 0, W, H);

  const idx = marks.findIndex((m) => t >= m.start && t < m.end);
  const i = idx === -1 ? marks.length - 1 : idx;
  const mark = marks[i];
  const local = Math.max(0, Math.min(mark.duration, t - mark.start));
  const p = local / mark.duration;

  // A very slight pulse on the beat. Subtle on purpose — it reads as energy,
  // not as a bug.
  const beatPhase = (t % fx.beat) / fx.beat;
  const pulse = 1 + Math.pow(1 - beatPhase, 6) * 0.012;

  const fromT = transformFor(fx, i, p, t);
  fromT.scale *= pulse;

  const tailLeft = mark.duration - local;
  const inTransition = tailLeft < fx.transitionLength && images[i + 1];

  if (inTransition) {
    const k = 1 - tailLeft / fx.transitionLength;
    const nextP = 0;
    const toT = transformFor(fx, i + 1, nextP, t);
    toT.scale *= pulse;
    const name = fx.transitions[i] || "fade";
    const fn = TRANSITIONS[name] || TRANSITIONS.fade;
    fn(ctx, {
      from: images[i],
      to: images[i + 1],
      k,
      fromT,
      toT,
      rand: (n) => mulberry32(Math.floor(t * 12) * 97 + n * 31)(),
    });
  } else {
    drawCover(ctx, images[i], fromT);
  }

  if (fx.leak) drawLightLeak(ctx, t, theme, fx.leakSeed);
  drawScrim(ctx, theme);
  drawGrain(ctx, t, fx.grain);
  drawVignette(ctx, fx.vignette);

  drawCaption(
    ctx,
    scenes[i]?.onScreenText,
    local,
    mark.duration,
    theme,
    fx.captions[i] || "popIn",
    fx.beat
  );
  drawHook(ctx, hook, t, theme, fx.beat);
  drawHandle(ctx, handle, theme);
  drawProgressBar(ctx, t, total, theme);
}

/* ── recording ─────────────────────────────────────────── */

/**
 * Phone encoders choke on 1080x1920 at 9 Mbps. They drop most frames, and some
 * hand back a file with no usable duration at all. Dropping to 720x1280 at
 * 5 Mbps is the difference between a working reel and a 0:00 one. Instagram
 * accepts 720x1280 and re-encodes everything on upload anyway, so the finished
 * post looks the same either way.
 */
function pickCaptureSize() {
  if (typeof navigator === "undefined") return { width: W, height: H, scale: 1, bitrate: 9_000_000 };

  const ua = navigator.userAgent || "";
  const mobile = /iPhone|iPad|iPod|Android/i.test(ua) || navigator.maxTouchPoints > 2;
  const weak = mobile || (navigator.hardwareConcurrency || 8) <= 4;

  if (!weak) return { width: W, height: H, scale: 1, bitrate: 9_000_000 };

  const scale = 720 / W;
  return { width: 720, height: 1280, scale, bitrate: 5_000_000 };
}

function pickMimeType(withAudio) {
  const ua = typeof navigator !== "undefined" ? navigator.userAgent || "" : "";
  const android = /Android/i.test(ua);
  const ios = /iPhone|iPad|iPod/i.test(ua) || (typeof navigator !== "undefined" && navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

  // Prefer native MP4 on Android too. This makes the common Download/Save path
  // instant and avoids a 60-120s WebAssembly transcode. FFmpeg remains available
  // as a fallback when a browser only exposes WebM.
  const preferWebM = false;

  const candidates = withAudio
    ? preferWebM
      ? [
          "video/webm;codecs=vp9,opus",
          "video/webm;codecs=vp8,opus",
          "video/webm",
          "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
          "video/mp4;codecs=avc1,mp4a.40.2",
          "video/mp4",
        ]
      : [
          "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
          "video/mp4;codecs=avc1,mp4a.40.2",
          "video/mp4;codecs=h264,aac",
          "video/mp4",
          "video/webm;codecs=vp9,opus",
          "video/webm;codecs=vp8,opus",
          "video/webm",
        ]
    : preferWebM
      ? [
          "video/webm;codecs=vp9",
          "video/webm;codecs=vp8",
          "video/webm",
          "video/mp4;codecs=avc1.42E01E",
          "video/mp4",
        ]
      : [
          "video/mp4;codecs=avc1.42E01E",
          "video/mp4",
          "video/webm;codecs=vp9",
          "video/webm",
        ];

  for (const type of candidates) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(type)) return type;
  }
  return "";
}

/**
 * Render and record. `state` is the same object drawFrame takes, plus:
 *   state.niche   - drives which musical genre gets picked
 *   state.seed    - makes the whole render reproducible
 *   state.mood    - "energetic" | "balanced" | "calm"
 *   state.audio   - { enabled, genre, volume, intensity }
 *
 * Resolves with { blob, ext, mimeType, hasAudio, music, seed, durationSeconds,
 * width, height, droppedFrames }.
 */
export async function recordReel(canvas, state, onProgress) {
  const seed = state.seed || Math.floor(Math.random() * 1e9);
  state.seed = seed;

  // Instagram rejects anything under 3 seconds outright.
  if (state.total < 3) {
    throw new Error(
      `This reel is only ${state.total.toFixed(1)}s. Instagram needs at least 3 seconds — add a scene or make them longer.`
    );
  }

  const capture = pickCaptureSize();
  canvas.width = capture.width;
  canvas.height = capture.height;

  const ctx = canvas.getContext("2d", { alpha: false });
  const fps = 24;

  const audioOpts = { enabled: true, volume: 0.85, intensity: 1, ...(state.audio || {}) };

  let audioCtx = null;
  let score = null;
  let dest = null;

  if (audioOpts.enabled && typeof window !== "undefined") {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) {
      try {
        audioCtx = new AC();
        if (audioCtx.state === "suspended") await audioCtx.resume();
      } catch {
        audioCtx = null; // silent reel beats a failed render
      }
    }
  }

  let bpmForVisuals = state.bpm || 100;

  if (audioCtx) {
    const cuts = state.marks.slice(1).map((m) => m.start);
    const accents = state.marks.map((m) => m.start + 0.05);

    score = buildScore(audioCtx, {
      seconds: state.total,
      niche: state.niche || "motivation",
      seed,
      startAt: audioCtx.currentTime + 0.25,
      volume: audioOpts.volume,
      intensity: audioOpts.intensity,
      genre: audioOpts.genre,
      cuts,
      accents,
    });

    bpmForVisuals = score.bpm;
    dest = audioCtx.createMediaStreamDestination();
    score.output.connect(dest);
  }

  state.bpm = bpmForVisuals;
  state.fx = buildEffectPlan({
    sceneCount: state.scenes.length,
    seed,
    mood:
      state.mood ||
      (bpmForVisuals > 118 ? "energetic" : bpmForVisuals < 88 ? "calm" : "balanced"),
    bpm: bpmForVisuals,
  });

  // Capture frames explicitly when the browser supports requestFrame().
  // This avoids relying on canvas-change heuristics that can produce a short
  // video track on mobile while the Web Audio track continues to the end.
  let stream;
  let videoTrack;
  let manualFrameCapture = false;

  try {
    const candidate = canvas.captureStream(0);
    const track = candidate.getVideoTracks()[0];
    if (track && typeof track.requestFrame === "function") {
      stream = candidate;
      videoTrack = track;
      manualFrameCapture = true;
    } else {
      candidate.getTracks().forEach((trackToStop) => trackToStop.stop());
      stream = canvas.captureStream(fps);
      videoTrack = stream.getVideoTracks()[0] || null;
    }
  } catch {
    stream = canvas.captureStream(fps);
    videoTrack = stream.getVideoTracks()[0] || null;
  }

  if (dest) dest.stream.getAudioTracks().forEach((track) => stream.addTrack(track));

  const mimeType = pickMimeType(Boolean(dest));

  let recorder;
  try {
    recorder = new MediaRecorder(stream, {
      mimeType: mimeType || undefined,
      videoBitsPerSecond: capture.bitrate,
      audioBitsPerSecond: 128_000,
    });
  } catch {
    // Some phones reject the options object wholesale. Bare constructor works.
    try {
      recorder = new MediaRecorder(stream);
    } catch (err2) {
      audioCtx?.close?.();
      throw new Error(`This browser cannot record canvas video: ${err2.message}`);
    }
  }

  return new Promise((resolve, reject) => {
    const chunks = [];
    let finished = false;
    let completedNormally = false;
    let frames = 0;
    let startedAt = 0;

    const cleanup = () => {
      document.removeEventListener("visibilitychange", onHide);
      stream.getTracks().forEach((track) => track.stop());
      audioCtx?.close?.();
    };

    const fail = (message) => {
      if (finished) return;
      finished = true;
      cleanup();
      if (recorder.state !== "inactive") {
        try {
          recorder.stop();
        } catch {
          /* already stopping */
        }
      }
      reject(new Error(message));
    };

    /**
     * Backgrounding the tab pauses requestAnimationFrame. The recorder keeps
     * running against a frozen canvas, and you end up with a file that is
     * mostly one still frame. Better to stop and say so.
     */
    function onHide() {
      if (document.hidden && !finished) {
        fail("Rendering stopped because the app went to the background. Keep this screen open while the reel renders.");
      }
    }
    document.addEventListener("visibilitychange", onHide);

    recorder.ondataavailable = (e) => e.data && e.data.size > 0 && chunks.push(e.data);
    recorder.onerror = (e) => fail(e.error?.message || "The recorder failed partway through.");

    recorder.onstop = async () => {
      if (finished) return;
      finished = true;
      document.removeEventListener("visibilitychange", onHide);

      const type = recorder.mimeType || mimeType || "video/webm";

      if (!completedNormally) {
        reject(
          new Error(
            "The video recorder stopped before the reel finished. Please keep the CreatorFlow tab open and try the render again."
          )
        );
        return;
      }

      stream.getTracks().forEach((track) => track.stop());
      audioCtx?.close?.();

      let blob = new Blob(chunks, { type });

      if (blob.size === 0) {
        reject(new Error("The recorder produced an empty file. Try again, or switch browser."));
        return;
      }

      // The authored timeline is the source of truth. The small recorder flush
      // tail is intentionally excluded from the final export duration.
      const durationSeconds = state.total;

      // Write a real duration into the WebM header so galleries and Instagram
      // stop reporting 0:00.
      blob = await fixWebmDuration(blob, Math.round(durationSeconds * 1000));
      const expectedFrames = Math.round(durationSeconds * fps);

      resolve({
        blob,
        ext: type.includes("mp4") ? "mp4" : type.includes("matroska") ? "mkv" : "webm",
        mimeType: type,
        hasAudio: Boolean(dest),
        music: score
          ? { genre: score.genre, label: score.genreLabel, bpm: score.bpm }
          : null,
        seed,
        durationSeconds,
        width: capture.width,
        height: capture.height,
        droppedFrames: Math.max(0, expectedFrames - frames),
      });
    };

    const leadIn = audioCtx ? 250 : 0;

    setTimeout(() => {
      if (finished) return;

      try {
        // A 100ms timeslice keeps chunks small, which matters on phones where a
        // single large chunk can exhaust memory mid-render.
        recorder.start(100);
      } catch (err) {
        fail(`Could not start recording: ${err.message}`);
        return;
      }

      startedAt = performance.now();

      function tick() {
        if (finished) return;

        const t = (performance.now() - startedAt) / 1000;

        // Everything is authored in 1080x1920 space; this scales it down to
        // whatever the encoder can actually keep up with.
        ctx.setTransform(capture.scale, 0, 0, capture.scale, 0, 0);

        if (t >= state.total) {
          drawFrame(ctx, state.total - 0.001, state);
          frames++;
          if (manualFrameCapture) videoTrack?.requestFrame?.();
          completedNormally = true;
          onProgress?.(1);
          // Let the encoder flush the tail before closing the file.
          setTimeout(() => {
            if (recorder.state !== "inactive") recorder.stop();
          }, 400);
          return;
        }

        drawFrame(ctx, t, state);
        frames++;
        if (manualFrameCapture) videoTrack?.requestFrame?.();
        onProgress?.(t / state.total);
        requestAnimationFrame(tick);
      }

      requestAnimationFrame(tick);
    }, leadIn);
  });
}

/* ── themes ────────────────────────────────────────────── */

export const THEMES = {
  bold: {
    fontStack: '"Bricolage Grotesque", Impact, sans-serif',
    textColor: "#FFFFFF",
    accent: "#F5B13C",
    tint: null,
    leak: "rgba(255,196,120,0.15)",
  },
  warm: {
    fontStack: '"Bricolage Grotesque", Georgia, serif',
    textColor: "#FFF3E0",
    accent: "#FF8A5B",
    tint: "rgba(255,160,80,0.10)",
    leak: "rgba(255,150,90,0.18)",
  },
  cool: {
    fontStack: '"Instrument Sans", Helvetica, sans-serif',
    textColor: "#EAF7FF",
    accent: "#63D2C8",
    tint: "rgba(70,190,220,0.10)",
    leak: "rgba(120,220,255,0.14)",
  },
  mono: {
    fontStack: '"Instrument Sans", Helvetica, sans-serif',
    textColor: "#FFFFFF",
    accent: "#FFFFFF",
    tint: "rgba(0,0,0,0.05)",
    leak: "rgba(255,255,255,0.10)",
  },
  neon: {
    fontStack: '"Bricolage Grotesque", Impact, sans-serif',
    textColor: "#FFFFFF",
    accent: "#FF3D8B",
    tint: "rgba(150,60,220,0.12)",
    leak: "rgba(255,70,180,0.16)",
  },
};

export { MOVE_KEYS, TRANSITION_KEYS, CAPTION_STYLES, pickGenre };
