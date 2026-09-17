import { chatJSON, availableTextProviders } from "@/lib/llm";
import { buildSystem, buildUser, normalisePlan, NICHES } from "@/lib/prompt";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET() {
  return Response.json({ textProviders: availableTextProviders() });
}

export async function POST(request) {
  try {
    const body = await request.json();

    const format = body.format === "image" || body.format === "meme" ? body.format : "video";
    const sceneCount = Math.min(6, Math.max(2, Number(body.sceneCount) || 4));
    const known = NICHES.find((n) => n.id === body.niche);

    const providerKeys = body.providerKeys && typeof body.providerKeys === "object" ? body.providerKeys : {};

    const { data, model } = await chatJSON(
      buildSystem(),
      buildUser({
        niche: known?.label || body.niche || "motivation",
        nicheNote: known?.note || "general audience",
        format,
        tone: body.tone || "punchy",
        language: body.language || "English",
        sceneCount,
        idea: body.idea || "",
        handle: body.handle || "",
      }),
      {
        provider: body.textProvider || "auto",
        keys: {
          groqApiKey: String(providerKeys.groqApiKey || ""),
          geminiApiKey: String(providerKeys.geminiApiKey || ""),
          openrouterApiKey: String(providerKeys.openrouterApiKey || ""),
          cerebrasApiKey: String(providerKeys.cerebrasApiKey || ""),
        },
      }
    );

    return Response.json({
      ok: true,
      model,
      plan: normalisePlan(data, { format, sceneCount }),
    });
  } catch (err) {
    return Response.json({ ok: false, error: err.message }, { status: 500 });
  }
}
