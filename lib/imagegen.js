/**
 * lib/imagegen.js — image router with native 9:16 output.
 *
 * WHAT CHANGED AND WHY THE OLD ONE LOOKED BAD
 *
 * 1. The Cloudflare call never sent width/height. Flux defaults to 1024x1024,
 *    so every scene came back square, got centre-cropped to 9:16 (throwing away
 *    about 45% of the frame) and was then upscaled to 1080x1920. That crop-plus-
 *    upscale is the blur you were seeing. Now every provider is asked for a
 *    portrait frame at or above the render size.
 * 2. Requests were 864x1536 and the canvas renders at 1080x1920, so even the
 *    good frames were being scaled up ~25%. Now they come back at 1088x1920 or
 *    larger, and Ken Burns zooms into real pixels instead of invented ones.
 * 3. Flux schnell was running 4 steps. 6-8 costs slightly more neurons and is
 *    visibly cleaner on detail and faces.
 * 4. Added Gemini (Nano Banana), which is the best free image model available
 *    and supports a real 9:16 aspect ratio flag rather than a crop.
 *
 * Exported API is unchanged: generateImage(prompt, opts).
 */

const RENDER_W = 1080;
const RENDER_H = 1920;

/** Flux wants dimensions on a multiple of 64. 1088x1920 is 9:16 within a pixel. */
const GEN_W = 1088;
const GEN_H = 1920;

function toDataURL(buffer, mime = "image/jpeg") {
  return `data:${mime};base64,${Buffer.from(buffer).toString("base64")}`;
}

function withTimeout(ms, label) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return {
    signal: controller.signal,
    done: () => clearTimeout(timer),
    label,
  };
}

/* ── Gemini / Nano Banana ──────────────────────────────── */

const GEMINI_IMAGE_MODELS = ["gemini-2.5-flash-image", "gemini-2.0-flash-preview-image-generation"];

async function gemini(prompt, cfg, keys) {
  const key = keys.GEMINI_API_KEY || process.env.GEMINI_API_KEY;
  if (!key) throw new Error("gemini: no key");

  let lastError = "gemini: no model responded";

  for (const model of GEMINI_IMAGE_MODELS) {
    const t = withTimeout(45000, model);
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
        {
          method: "POST",
          signal: t.signal,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            generationConfig: {
              responseModalities: ["IMAGE"],
              // This is the part that matters: a real portrait render, not a crop.
              imageConfig: { aspectRatio: "9:16" },
            },
          }),
        }
      );
      t.done();

      if (!res.ok) {
        lastError = `gemini/${model} ${res.status}: ${(await res.text()).slice(0, 160)}`;
        continue;
      }

      const json = await res.json();
      const parts = json?.candidates?.[0]?.content?.parts || [];
      const image = parts.find((p) => p.inlineData?.data || p.inline_data?.data);
      const inline = image?.inlineData || image?.inline_data;

      if (!inline?.data) {
        lastError = `gemini/${model}: response had no image`;
        continue;
      }

      return {
        dataUrl: `data:${inline.mimeType || inline.mime_type || "image/png"};base64,${inline.data}`,
        provider: `gemini/${model}`,
        native: true,
      };
    } catch (err) {
      t.done();
      lastError = `gemini/${model}: ${err.message}`;
    }
  }

  throw new Error(lastError);
}

/* ── Cloudflare Workers AI ─────────────────────────────── */

async function cloudflare(prompt, cfg, keys) {
  const account = keys.CLOUDFLARE_ACCOUNT_ID || process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = keys.CLOUDFLARE_API_TOKEN || process.env.CLOUDFLARE_API_TOKEN;
  if (!account || !token) throw new Error("cloudflare: not configured");

  const t = withTimeout(50000, "cloudflare");
  try {
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/@cf/black-forest-labs/flux-1-schnell`,
      {
        method: "POST",
        signal: t.signal,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          prompt,
          // These four lines are the actual fix.
          width: cfg.width,
          height: cfg.height,
          steps: cfg.steps,
          seed: cfg.seed,
        }),
      }
    );
    t.done();

    if (!res.ok) throw new Error(`cloudflare ${res.status}: ${(await res.text()).slice(0, 160)}`);

    const type = res.headers.get("content-type") || "";
    if (type.includes("application/json")) {
      const json = await res.json();
      const b64 = json?.result?.image;
      if (!b64) throw new Error("cloudflare: no image in response");
      return {
        dataUrl: `data:image/jpeg;base64,${b64}`,
        provider: "cloudflare/flux-1-schnell",
        native: true,
      };
    }

    return {
      dataUrl: toDataURL(await res.arrayBuffer(), "image/jpeg"),
      provider: "cloudflare/flux-1-schnell",
      native: true,
    };
  } catch (err) {
    t.done();
    throw err;
  }
}

/* ── Together ──────────────────────────────────────────── */

async function together(prompt, cfg, keys) {
  const key = keys.TOGETHER_API_KEY || process.env.TOGETHER_API_KEY;
  if (!key) throw new Error("together: not configured");

  const t = withTimeout(50000, "together");
  try {
    const res = await fetch("https://api.together.xyz/v1/images/generations", {
      method: "POST",
      signal: t.signal,
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "black-forest-labs/FLUX.1-schnell-Free",
        prompt,
        width: cfg.width,
        height: cfg.height,
        steps: Math.min(4, cfg.steps), // the free endpoint caps at 4
        n: 1,
        seed: cfg.seed,
        response_format: "b64_json",
      }),
    });
    t.done();

    if (!res.ok) throw new Error(`together ${res.status}: ${(await res.text()).slice(0, 160)}`);
    const json = await res.json();
    const b64 = json?.data?.[0]?.b64_json;
    if (!b64) throw new Error("together: no image in response");
    return { dataUrl: `data:image/jpeg;base64,${b64}`, provider: "together/flux-schnell", native: true };
  } catch (err) {
    t.done();
    throw err;
  }
}

/* ── Pollinations ──────────────────────────────────────── */

async function pollinations(prompt, cfg, keys) {
  const params = new URLSearchParams({
    width: String(cfg.width),
    height: String(cfg.height),
    seed: String(cfg.seed),
    model: "flux",
    nologo: "true",
    enhance: "true",
    referrer: "creatorflow-ai",
  });

  const headers = {};
  const token = keys.POLLINATIONS_TOKEN || process.env.POLLINATIONS_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;

  const t = withTimeout(55000, "pollinations");
  try {
    const res = await fetch(
      `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?${params}`,
      { headers, signal: t.signal }
    );
    t.done();

    if (!res.ok) throw new Error(`pollinations ${res.status}`);
    const buf = await res.arrayBuffer();
    if (buf.byteLength < 4000) throw new Error("pollinations: response too small to be an image");

    return {
      dataUrl: toDataURL(buf, res.headers.get("content-type") || "image/jpeg"),
      provider: "pollinations/flux",
      native: true,
    };
  } catch (err) {
    t.done();
    throw err;
  }
}

/* ── graceful last resort ──────────────────────────────── */

function placeholder(cfg) {
  const hues = [188, 24, 352, 158, 268, 42];
  const hue = hues[Math.abs(cfg.seed) % hues.length];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${cfg.width}" height="${cfg.height}">
    <defs><linearGradient id="g" x1="0" y1="0" x2="0.55" y2="1">
      <stop offset="0%" stop-color="hsl(${hue},52%,26%)"/>
      <stop offset="100%" stop-color="hsl(${(hue + 44) % 360},58%,9%)"/>
    </linearGradient></defs>
    <rect width="100%" height="100%" fill="url(#g)"/>
  </svg>`;
  return {
    dataUrl: `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`,
    provider: "placeholder",
    native: false,
  };
}

/* ── the router ────────────────────────────────────────── */

const CHAIN = {
  gemini,
  cloudflare,
  together,
  pollinations,
};

/**
 * Quality order, not availability order. Gemini renders a true 9:16 frame and
 * handles people far better than Flux schnell, so it leads when a key exists.
 */
const DEFAULT_ORDER = ["gemini", "cloudflare", "together", "pollinations"];

export function availableImageProviders(keys = {}) {
  const has = (k) => Boolean(keys[k] || process.env[k]);
  return {
    gemini: has("GEMINI_API_KEY"),
    cloudflare: has("CLOUDFLARE_ACCOUNT_ID") && has("CLOUDFLARE_API_TOKEN"),
    together: has("TOGETHER_API_KEY"),
    pollinations: true,
  };
}

export async function generateImage(prompt, opts = {}) {
  const keys = opts.providerKeys || {};

  const cfg = {
    width: opts.width || GEN_W,
    height: opts.height || GEN_H,
    steps: Math.min(8, Math.max(4, opts.steps || 7)),
    seed: Number.isFinite(opts.seed) ? Math.abs(Math.floor(opts.seed)) : Math.floor(Math.random() * 1e6),
  };

  // Honour an explicit pick, then fall through the rest of the chain anyway.
  const preferred = opts.imageProvider && CHAIN[opts.imageProvider] ? [opts.imageProvider] : [];
  const order = [...preferred, ...DEFAULT_ORDER.filter((p) => !preferred.includes(p))];

  const failures = [];

  for (const name of order) {
    try {
      const result = await CHAIN[name](prompt, cfg, keys);
      return { ...result, width: cfg.width, height: cfg.height, attempts: failures };
    } catch (err) {
      failures.push(`${name}: ${err.message}`);
    }
  }

  return { ...placeholder(cfg), warning: failures.join(" | "), attempts: failures };
}

export const RENDER_SIZE = { width: RENDER_W, height: RENDER_H };
