/**
 * Free-tier image router.
 *
 * Everything comes back as a base64 data URL on purpose. If the browser loaded
 * these straight from pollinations.ai the canvas would become "tainted" and
 * both toBlob() and captureStream() would throw a security error — which would
 * break video export entirely. Routing the bytes through our own origin avoids
 * that completely.
 */

function toDataURL(buffer, mime = "image/jpeg") {
  return `data:${mime};base64,${Buffer.from(buffer).toString("base64")}`;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, ms, label) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return promise(controller.signal).finally(() => clearTimeout(timer)).catch((err) => {
    if (err.name === "AbortError") throw new Error(`${label}: timed out`);
    throw err;
  });
}

async function cloudflare(prompt, { width, height, seed, keys = {} }) {
  const account = keys.cloudflareAccountId || process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = keys.cloudflareApiToken || process.env.CLOUDFLARE_API_TOKEN;
  if (!account || !token) throw new Error("cloudflare: not configured");

  const res = await withTimeout(
    (signal) => fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/@cf/black-forest-labs/flux-1-schnell`, {
      method: "POST",
      signal,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ prompt, seed, steps: 6, width, height }),
    }),
    45000,
    "cloudflare"
  );

  if (!res.ok) throw new Error(`cloudflare ${res.status}: ${(await res.text()).slice(0, 180)}`);

  const type = res.headers.get("content-type") || "";
  if (type.includes("application/json")) {
    const json = await res.json();
    const b64 = json?.result?.image;
    if (!b64) throw new Error("cloudflare: no image in response");
    return { dataUrl: `data:image/jpeg;base64,${b64}`, provider: "cloudflare/flux-1-schnell" };
  }

  return {
    dataUrl: toDataURL(await res.arrayBuffer(), "image/jpeg"),
    provider: "cloudflare/flux-1-schnell",
  };
}

async function together(prompt, { width, height, seed, keys = {} }) {
  const key = keys.togetherApiKey || process.env.TOGETHER_API_KEY;
  if (!key) throw new Error("together: not configured");

  const res = await withTimeout((signal) => fetch("https://api.together.xyz/v1/images/generations", {
    method: "POST",
    signal,
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "black-forest-labs/FLUX.1-schnell-Free",
      prompt,
      width,
      height,
      steps: 4,
      n: 1,
      seed,
      response_format: "b64_json",
    }),
  }), 45000, "together");

  if (!res.ok) throw new Error(`together ${res.status}: ${(await res.text()).slice(0, 180)}`);
  const json = await res.json();
  const b64 = json?.data?.[0]?.b64_json;
  if (!b64) throw new Error("together: no image in response");
  return { dataUrl: `data:image/jpeg;base64,${b64}`, provider: "together/flux-schnell" };
}

async function pollinations(prompt, { width, height, seed, keys = {} }) {
  const params = new URLSearchParams({
    width: String(width),
    height: String(height),
    seed: String(seed),
    model: "flux",
    nologo: "true",
    referrer: "reel-desk",
  });

  const headers = {};
  const token = keys.pollinationsToken || process.env.POLLINATIONS_TOKEN;
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const res = await withTimeout(
    (signal) => fetch(`https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?${params}`, { headers, signal }),
    60000,
    "pollinations"
  );

  if (!res.ok) throw new Error(`pollinations ${res.status}`);
  const buf = await res.arrayBuffer();
  if (buf.byteLength < 2000) throw new Error("pollinations: response too small to be an image");

  return {
    dataUrl: toDataURL(buf, res.headers.get("content-type") || "image/jpeg"),
    provider: "pollinations/flux",
  };
}

export async function generateImage(prompt, opts = {}) {
  const config = {
    width: opts.width || 864,
    height: opts.height || 1536,
    seed: opts.seed ?? Math.floor(Math.random() * 1e6),
    keys: opts.keys || {},
  };

  const preferred = opts.provider || process.env.IMAGE_PROVIDER || "auto";
  const providers = { cloudflare, together, pollinations };
  const chain =
    preferred !== "auto" && providers[preferred]
      ? [providers[preferred], ...Object.entries(providers).filter(([name]) => name !== preferred).map(([, fn]) => fn)]
      : [cloudflare, together, pollinations];
  const failures = [];

  for (const provider of chain) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await provider(prompt, { ...config, seed: config.seed + attempt * 101 });
      } catch (err) {
        failures.push(err.message);
        if (/429|rate|busy|timeout|timed out/i.test(err.message)) {
          await wait(900 + attempt * 1200);
        }
      }
    }
  }

  throw new Error(`Image providers failed for this scene. ${failures.slice(-4).join(" | ")}`);
}
