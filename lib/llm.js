/**
 * Free-tier LLM router.
 *
 * Providers are tried in order. Within a provider, model ids are tried in
 * order too — free catalogues churn constantly (Cerebras silently deleted most
 * of its free models in May 2026), so never depend on one id staying alive.
 */

const PROVIDERS = [
  {
    name: "groq",
    key: (keys = {}) => keys.groqApiKey || process.env.GROQ_API_KEY,
    url: "https://api.groq.com/openai/v1/chat/completions",
    models: [
      "llama-3.3-70b-versatile",
      "openai/gpt-oss-120b",
      "llama-3.1-8b-instant",
    ],
    shape: "openai",
  },
  {
    name: "gemini",
    key: (keys = {}) => keys.geminiApiKey || process.env.GEMINI_API_KEY,
    models: ["gemini-2.5-flash", "gemini-2.0-flash"],
    shape: "gemini",
  },
  {
    name: "openrouter",
    key: (keys = {}) => keys.openrouterApiKey || process.env.OPENROUTER_API_KEY,
    url: "https://openrouter.ai/api/v1/chat/completions",
    models: [
      "meta-llama/llama-3.3-70b-instruct:free",
      "deepseek/deepseek-chat-v3-0324:free",
      "google/gemma-3-27b-it:free",
    ],
    shape: "openai",
  },
  {
    name: "cerebras",
    key: (keys = {}) => keys.cerebrasApiKey || process.env.CEREBRAS_API_KEY,
    url: "https://api.cerebras.ai/v1/chat/completions",
    models: ["gpt-oss-120b", "llama-3.3-70b"],
    shape: "openai",
  },
];

async function callOpenAIShape(provider, model, system, user, signal, keys) {
  const res = await fetch(provider.url, {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${provider.key(keys)}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0.95,
      max_tokens: 2200,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });

  if (!res.ok) throw new Error(`${provider.name}/${model} ${res.status}: ${(await res.text()).slice(0, 220)}`);
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new Error(`${provider.name}/${model} returned no content`);
  return text;
}

async function callGeminiShape(provider, model, system, user, signal, keys) {
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent` +
    `?key=${provider.key(keys)}`;

  const res = await fetch(url, {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: user }] }],
      generationConfig: {
        temperature: 0.95,
        maxOutputTokens: 2200,
        responseMimeType: "application/json",
      },
    }),
  });

  if (!res.ok) throw new Error(`gemini/${model} ${res.status}: ${(await res.text()).slice(0, 220)}`);
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("");
  if (!text) throw new Error(`gemini/${model} returned no content`);
  return text;
}

/** Models sometimes wrap JSON in prose or fences. Dig it out. */
function extractJSON(raw) {
  let s = String(raw).trim();
  s = s.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();

  try {
    return JSON.parse(s);
  } catch {
    /* fall through */
  }

  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start !== -1 && end > start) {
    return JSON.parse(s.slice(start, end + 1));
  }
  throw new Error("Model did not return usable JSON");
}

export function availableTextProviders(keys = {}) {
  return PROVIDERS.filter((p) => p.key(keys)).map((p) => p.name);
}

export async function chatJSON(system, user, opts = {}) {
  const keys = opts.keys || {};
  const preferred = opts.provider || process.env.TEXT_PROVIDER || "auto";
  const available = PROVIDERS.filter((p) => p.key(keys));
  const usable =
    preferred !== "auto"
      ? [...available.filter((p) => p.name === preferred), ...available.filter((p) => p.name !== preferred)]
      : available;

  if (usable.length === 0) {
    throw new Error(
      "No text model configured. Add GROQ_API_KEY (free, no card) in your environment variables."
    );
  }

  const failures = [];

  for (const provider of usable) {
    for (const model of provider.models) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 40000);
      try {
        const raw =
          provider.shape === "gemini"
            ? await callGeminiShape(provider, model, system, user, controller.signal, keys)
            : await callOpenAIShape(provider, model, system, user, controller.signal, keys);
        clearTimeout(timer);
        return { data: extractJSON(raw), model: `${provider.name}/${model}` };
      } catch (err) {
        clearTimeout(timer);
        failures.push(err.message);
      }
    }
  }

  throw new Error(`Every text model failed.\n${failures.join("\n")}`);
}
