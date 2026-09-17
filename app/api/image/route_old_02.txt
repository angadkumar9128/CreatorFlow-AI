import { generateImage, availableImageProviders } from "@/lib/imagegen";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Style suffixes rewritten. The old ones were a handful of adjectives, which
 * Flux mostly ignores. These name a camera, a lens, a light source and a grade,
 * because diffusion models respond to concrete photographic vocabulary far more
 * than to words like "high quality".
 *
 * Every one also reserves the lower third for the caption overlay, so text
 * never lands on a busy part of the frame.
 */
const STYLE_SUFFIX = {
  photoreal:
    "shot on a Sony A7 IV with a 35mm f/1.4 lens, shallow depth of field, natural window light with soft falloff, subtle film grain, muted cinematic colour grade, sharp focus on the subject, clean uncluttered lower third, full-length vertical 9:16 framing",
  editorial:
    "editorial magazine photography, medium format Hasselblad look, single large softbox key light with a rim light behind, deliberate negative space in the upper third, restrained colour palette of two or three tones, crisp detail, vertical 9:16 framing",
  illustrated:
    "bold flat vector illustration, thick confident shapes, three-colour palette with one accent, strong silhouette reading at thumbnail size, generous flat background area in the lower third, vertical 9:16 framing",
  moody:
    "low-key cinematic lighting, single hard practical light source, deep crushed shadows, volumetric haze, teal shadows and warm amber highlights, anamorphic look, shot on 50mm, vertical 9:16 framing",
  vibrant:
    "high energy commercial photography, saturated punchy colours, crisp studio lighting with coloured gels, glossy highlights, strong contrast, shot on 24mm for slight drama, vertical 9:16 framing",
  cinematic:
    "cinematic still frame, 2.39 anamorphic lens flare, golden hour backlight, atmospheric dust in the air, desaturated shadows with warm midtones, shot on Arri Alexa, vertical 9:16 framing",
  minimal:
    "minimalist composition, one clear subject against a large clean background, soft even lighting, muted neutral palette, generous empty space, vertical 9:16 framing",
};

/** Stated once, applied to every render. */
const NEGATIVE =
  "no text, no letters, no words, no captions, no watermark, no logo, no signature, " +
  "no extra limbs, no deformed hands, no distorted faces, no blurry low-resolution artefacts, " +
  "not a collage, not a split screen, no borders, no frame";

export async function GET() {
  return Response.json({ imageProviders: availableImageProviders() });
}

export async function POST(request) {
  try {
    const body = await request.json();
    const { prompt, style = "photoreal", seed, imageProvider, providerKeys = {}, steps } = body;

    if (!prompt || typeof prompt !== "string") {
      return Response.json({ ok: false, error: "A prompt is required." }, { status: 400 });
    }

    const suffix = STYLE_SUFFIX[style] || STYLE_SUFFIX.photoreal;

    // Subject first, then craft, then exclusions. Diffusion models weight the
    // opening tokens most heavily, so the scene description has to lead.
    const full = `${prompt.trim()}. ${suffix}. ${NEGATIVE}.`;

    const result = await generateImage(full, {
      seed: Number.isFinite(seed) ? seed : Math.floor(Math.random() * 1e6),
      steps,
      imageProvider,
      providerKeys,
    });

    return Response.json({ ok: true, ...result });
  } catch (err) {
    return Response.json({ ok: false, error: err.message }, { status: 500 });
  }
}
