const GEMINI_UPLOAD_URL = "https://generativelanguage.googleapis.com/upload/v1beta/files";
const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";
const MODEL = "gemini-2.5-flash-lite";
const AI_MIN_SHORT_SECONDS = 8;
const AI_MAX_SHORT_SECONDS = 39;

function cleanKey(key) {
  return String(key || "").trim();
}

async function uploadGeminiFileDirect(file, apiKey, onProgress) {
  const key = cleanKey(apiKey);
  if (!key) throw new Error("Add your Gemini API key in AI Providers before using AI Shorts.");
  if (!file?.size) throw new Error("No video file was provided.");
  const mimeType = file.type || "video/mp4";

  onProgress?.({ stage: "uploading", ratio: 0.05 });
  const start = await fetch(`${GEMINI_UPLOAD_URL}?key=${encodeURIComponent(key)}`, {
    method: "POST",
    headers: {
      "X-Goog-Upload-Protocol": "resumable",
      "X-Goog-Upload-Command": "start",
      "X-Goog-Upload-Header-Content-Length": String(file.size),
      "X-Goog-Upload-Header-Content-Type": mimeType,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ file: { display_name: file.name || "creatorflow-video" } }),
  });

  if (!start.ok) {
    throw new Error(`Gemini upload setup failed (${start.status}). Check that your Gemini key is valid and active.`);
  }

  const uploadUrl = start.headers.get("x-goog-upload-url");
  if (!uploadUrl) throw new Error("Gemini did not return an upload URL.");

  const upload = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      "X-Goog-Upload-Offset": "0",
      "X-Goog-Upload-Command": "upload, finalize",
      "Content-Type": mimeType,
    },
    body: file,
  });

  if (!upload.ok) throw new Error(`Gemini video upload failed (${upload.status}).`);
  const info = await upload.json();
  const uploaded = info?.file;
  if (!uploaded?.uri || !uploaded?.name) throw new Error("Gemini upload returned an invalid file reference.");

  onProgress?.({ stage: "processing", ratio: 0.25 });
  let current = uploaded;
  for (let i = 0; i < 60; i += 1) {
    const state = String(current.state || "").toUpperCase();
    if (state === "ACTIVE") return current;
    if (state === "FAILED") throw new Error("Gemini could not process this video.");
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const status = await fetch(`${GEMINI_API_BASE}/${current.name}?key=${encodeURIComponent(key)}`);
    if (!status.ok) throw new Error(`Gemini file status failed (${status.status}).`);
    const data = await status.json();
    current = data.file || data;
    onProgress?.({ stage: "processing", ratio: Math.min(0.45, 0.25 + (i / 60) * 0.2) });
  }
  throw new Error("Gemini video processing timed out. Try again or use a shorter video.");
}

async function askGeminiDirect(fileRef, apiKey, prompt) {
  const key = cleanKey(apiKey);
  const res = await fetch(
    `${GEMINI_API_BASE}/models/${MODEL}:generateContent?key=${encodeURIComponent(key)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{
          parts: [
            { text: prompt },
            { file_data: { mime_type: fileRef.mimeType || "video/mp4", file_uri: fileRef.uri } },
          ],
        }],
        generationConfig: {
          temperature: 0.55,
          maxOutputTokens: 12000,
          responseMimeType: "application/json",
        },
      }),
    }
  );
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 400);
    throw new Error(`Gemini analysis failed (${res.status}): ${detail}`);
  }
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";
  if (!text) throw new Error("Gemini returned no analysis.");
  return parseJSON(text);
}

function parseJSON(raw) {
  let value = String(raw).trim().replace(/^\`\`\`(?:json)?/i, "").replace(/\`\`\`$/i, "").trim();
  try { return JSON.parse(value); } catch {}
  const start = value.indexOf("{");
  const end = value.lastIndexOf("}");
  if (start >= 0 && end > start) return JSON.parse(value.slice(start, end + 1));
  throw new Error("Gemini returned invalid JSON.");
}

function normalizeClip(clip, duration) {
  const start = Math.max(0, Number(clip?.start) || 0);
  const end = Math.min(duration, Number(clip?.end) || start + 30);
  if (end - start < AI_MIN_SHORT_SECONDS) return null;
  const boundedEnd = Math.min(end, start + AI_MAX_SHORT_SECONDS, duration);
  if (boundedEnd - start < AI_MIN_SHORT_SECONDS) return null;
  const hashtags = Array.isArray(clip?.hashtags)
    ? clip.hashtags.map((tag) => String(tag || "").trim().replace(/^#?/, "#")).filter((tag) => tag.length > 1).slice(0, 12)
    : [];
  return {
    start: Number(start.toFixed(1)),
    end: Number(boundedEnd.toFixed(1)),
    score: Math.max(0, Math.min(100, Number(clip?.score) || 0)),
    reason: String(clip?.reason || "Strong standalone moment"),
    title: String(clip?.title || "AI selected moment").trim(),
    description: String(clip?.description || clip?.caption || "").trim(),
    hashtags,
  };
}

function normalizeCaptions(captions, duration) {
  return (Array.isArray(captions) ? captions : [])
    .map((caption) => {
      const start = Math.max(0, Number(caption?.start) || 0);
      const end = Math.min(duration, Number(caption?.end) || start + 2);
      const text = String(caption?.text || "").trim();
      return end > start && text ? { start: Number(start.toFixed(2)), end: Number(end.toFixed(2)), text } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.start - b.start)
    .slice(0, 500);
}

async function uploadGeminiFileViaServer(file, onProgress) {
  if (!file?.size) throw new Error("No video file was provided.");
  onProgress?.({ stage: "uploading", ratio: 0.05 });

  const start = await fetch("/api/ai/gemini?action=start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      fileName: file.name || "creatorflow-video",
      fileSize: file.size,
      mimeType: file.type || "video/mp4",
    }),
  });
  const startData = await start.json().catch(() => ({}));
  if (!start.ok || !startData.uploadUrl) {
    throw new Error(startData.error || `Gemini server upload setup failed (${start.status}).`);
  }

  const chunkSize = 4 * 1024 * 1024;
  let offset = 0;
  while (offset < file.size) {
    const end = Math.min(file.size, offset + chunkSize);
    const chunk = file.slice(offset, end);
    const isFinal = end >= file.size;
    const command = isFinal ? "upload, finalize" : "upload";

    const res = await fetch("/api/ai/gemini?action=chunk", {
      method: "POST",
      headers: {
        "X-Gemini-Upload-Url": startData.uploadUrl,
        "X-Gemini-Upload-Offset": String(offset),
        "X-Gemini-Upload-Command": command,
      },
      body: chunk,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Gemini video upload failed (${res.status}).`);
    offset = end;
    onProgress?.({ stage: "uploading", ratio: 0.05 + (offset / file.size) * 0.2 });
    if (isFinal) {
      const uploaded = data?.file || data;
      if (!uploaded?.uri || !uploaded?.name) throw new Error("Gemini upload returned an invalid file reference.");
      onProgress?.({ stage: "processing", ratio: 0.3 });
      let current = uploaded;
      for (let i = 0; i < 60; i += 1) {
        const state = String(current.state || "").toUpperCase();
        if (state === "ACTIVE") return current;
        if (state === "FAILED") throw new Error("Gemini could not process this video.");
        await new Promise((resolve) => setTimeout(resolve, 2000));
        const status = await fetch("/api/ai/gemini?action=status", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: current.name }),
        });
        const statusData = await status.json().catch(() => ({}));
        if (!status.ok) throw new Error(statusData.error || `Gemini file status failed (${status.status}).`);
        current = statusData.file || statusData;
        onProgress?.({ stage: "processing", ratio: Math.min(0.5, 0.3 + (i / 60) * 0.2) });
      }
      throw new Error("Gemini video processing timed out. Try again or use a shorter video.");
    }
  }
  throw new Error("Gemini upload did not finish.");
}

async function askGeminiViaServer(fileRef, prompt) {
  const res = await fetch("/api/ai/gemini?action=analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fileRef, prompt }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Gemini analysis failed (${res.status}).`);
  const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";
  if (!text) throw new Error("Gemini returned no analysis.");
  return parseJSON(text);
}

export async function analyzeVideoForCreator(file, apiKey, duration, options = {}) {
  const maxClips = Math.max(1, Math.min(12, Number(options.maxClips) || 8));
  const targetLength = Math.max(10, Math.min(180, Number(options.targetLength) || 45));
  const fileRef = cleanKey(apiKey)
    ? await uploadGeminiFileDirect(file, apiKey, options.onProgress)
    : await uploadGeminiFileViaServer(file, options.onProgress);

  const prompt = `
You are an expert short-form video editor. Analyze the entire uploaded video and return ONLY valid JSON.

Goal: turn this source into high-retention Instagram Reels / YouTube Shorts / TikToks.

Select up to ${maxClips} strong, self-contained short-form moments. HARD REQUIREMENTS: every clip must be at least ${AI_MIN_SHORT_SECONDS} seconds and at most ${AI_MAX_SHORT_SECONDS} seconds. Prefer ${targetLength} seconds, with the ideal range being 15-39 seconds. Never return 2-7 second clips. Choose natural boundaries so the viewer gets a complete thought, setup + payoff, story beat, useful explanation, punchline, surprising fact, emotional moment, or strong conclusion. Do not overlap clips. Prefer hooks, surprising facts, emotional moments, useful explanations, stories, questions, punchlines, strong opinions, or clear conclusions. Avoid long silence, greetings, repeated filler, weak context, and incomplete sentences.

For EACH clip also create social metadata designed for Instagram:
- title: short, specific, curiosity-driven Reel/Short title
- description: 1-3 natural sentences describing the clip and encouraging meaningful engagement without spam
- hashtags: 8-12 relevant discovery hashtags. Mix broad and niche hashtags that genuinely match the topic. Do not claim a hashtag is currently trending unless you actually know that; do not use unrelated viral hashtags just for reach.

Also create readable burned-in captions for the selected moments. Caption chunks should be short (normally 2-8 words), timed with the spoken content, and safe for a vertical video. If exact word timing is unavailable, estimate sensible phrase-level timestamps.

Finally create 5 strong hook alternatives for the overall video. Hooks must be short, attention-grabbing, natural, and faithful to the source; do not invent claims.

Return exactly this JSON shape:
{
  "clips": [
    {"start": 0, "end": 30, "score": 92, "title": "Short title", "description": "A concise Instagram description for this clip.", "hashtags": ["#reels", "#shorts"], "reason": "Why this moment works"}
  ],
  "captions": [
    {"start": 0, "end": 2.4, "text": "Caption phrase"}
  ],
  "hooks": [
    {"text": "Hook text", "style": "curiosity"}
  ],
  "summary": "One short sentence describing the strongest content in the video."
}

Rules:
- All times are seconds from the original video.
- Keep every clip inside 0..\${duration}.
- HARD LIMIT: every clip must be 8-39 seconds. Prefer 15-39 seconds.
- Never output a clip shorter than 8 seconds.
- Captions must stay inside 0..\${duration}.
- Do not output markdown or commentary.
`;

  options.onProgress?.({ stage: "analyzing", ratio: 0.5 });
  const raw = cleanKey(apiKey)
    ? await askGeminiDirect(fileRef, apiKey, prompt)
    : await askGeminiViaServer(fileRef, prompt);
  const clips = (Array.isArray(raw.clips) ? raw.clips : [])
    .map((clip) => normalizeClip(clip, duration))
    .filter(Boolean)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxClips);

  clips.sort((a, b) => a.start - b.start);
  const nonOverlapping = [];
  for (const clip of clips) {
    if (!nonOverlapping.length || clip.start >= nonOverlapping[nonOverlapping.length - 1].end) nonOverlapping.push(clip);
  }

  options.onProgress?.({ stage: "finishing", ratio: 0.95 });
  return {
    clips: nonOverlapping,
    captions: normalizeCaptions(raw.captions, duration),
    hooks: Array.isArray(raw.hooks) ? raw.hooks.map((h) => ({ text: String(h?.text || h || "").trim(), style: String(h?.style || "curiosity") })).filter((h) => h.text).slice(0, 5) : [],
    summary: String(raw.summary || "").trim(),
    model: MODEL,
  };
}
