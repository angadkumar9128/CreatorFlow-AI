import { generateImage } from "@/lib/imagegen";

export const runtime = "nodejs";
export const maxDuration = 60;

const STYLE_SUFFIX = {
  photoreal:
    "shot on a 35mm lens, shallow depth of field, natural light, cinematic colour grade, vertical 9:16 composition, high detail",
  editorial:
    "editorial magazine photography, strong key light, clean negative space in the upper third, vertical 9:16 composition",
  illustrated:
    "bold flat vector illustration, thick shapes, limited palette, high contrast, vertical 9:16 composition",
  moody:
    "moody low-key lighting, deep shadows, volumetric haze, teal and amber palette, vertical 9:16 composition",
  vibrant:
    "vibrant saturated colours, high energy, crisp studio lighting, vertical 9:16 composition",
};

export async function POST(request) {
  try {
    const { prompt, style = "photoreal", seed, imageProvider = "auto", providerKeys = {} } = await request.json();

    if (!prompt || typeof prompt !== "string") {
      return Response.json({ ok: false, error: "A prompt is required." }, { status: 400 });
    }

    const suffix = STYLE_SUFFIX[style] || STYLE_SUFFIX.photoreal;
    const full = `${prompt.trim()}. ${suffix}. No text, no letters, no watermark, no logo.`;

    const result = await generateImage(full, {
      width: 864,
      height: 1536,
      seed: Number.isFinite(seed) ? seed : Math.floor(Math.random() * 1e6),
      provider: imageProvider,
      keys: {
        cloudflareAccountId: String(providerKeys.cloudflareAccountId || ""),
        cloudflareApiToken: String(providerKeys.cloudflareApiToken || ""),
        togetherApiKey: String(providerKeys.togetherApiKey || ""),
        pollinationsToken: String(providerKeys.pollinationsToken || ""),
      },
    });

    return Response.json({ ok: true, ...result });
  } catch (err) {
    return Response.json({ ok: false, error: err.message }, { status: 500 });
  }
}
