const GEMINI_UPLOAD_URL = "https://generativelanguage.googleapis.com/upload/v1beta/files";
const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";

function getKey() {
  return String(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "").trim();
}

function json(data, status = 200) {
  return Response.json(data, {
    status,
    headers: { "Cache-Control": "no-store, max-age=0" },
  });
}

export async function GET(request) {
  const action = new URL(request.url).searchParams.get("action");
  const key = getKey();
  if (action === "status") return json({ ok: true, configured: Boolean(key) });
  return json({ ok: false, error: "Unsupported action." }, 400);
}

export async function POST(request) {
  const action = new URL(request.url).searchParams.get("action");
  const key = getKey();

  if (!key) return json({ ok: false, error: "The app Gemini API key is not configured on Vercel." }, 503);

  try {
    if (action === "start") {
      const body = await request.json();
      const fileSize = Number(body?.fileSize) || 0;
      const mimeType = String(body?.mimeType || "video/mp4");
      const fileName = String(body?.fileName || "creatorflow-video").slice(0, 120);

      const res = await fetch(`${GEMINI_UPLOAD_URL}?key=${encodeURIComponent(key)}`, {
        method: "POST",
        headers: {
          "X-Goog-Upload-Protocol": "resumable",
          "X-Goog-Upload-Command": "start",
          "X-Goog-Upload-Header-Content-Length": String(fileSize),
          "X-Goog-Upload-Header-Content-Type": mimeType,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ file: { display_name: fileName } }),
      });

      if (!res.ok) return json({ ok: false, error: `Gemini upload setup failed (${res.status}).` }, res.status);
      const uploadUrl = res.headers.get("x-goog-upload-url");
      if (!uploadUrl) return json({ ok: false, error: "Gemini did not return an upload URL." }, 502);
      return json({ ok: true, uploadUrl });
    }

    if (action === "chunk") {
      const uploadUrl = String(request.headers.get("x-gemini-upload-url") || "");
      const offset = String(request.headers.get("x-gemini-upload-offset") || "0");
      const command = String(request.headers.get("x-gemini-upload-command") || "upload");
      if (!uploadUrl.startsWith("https://generativelanguage.googleapis.com/")) {
        return json({ ok: false, error: "Invalid Gemini upload session." }, 400);
      }

      const body = await request.arrayBuffer();
      if (!body.byteLength || body.byteLength > 4 * 1024 * 1024) {
        return json({ ok: false, error: "Upload chunk must be between 1 byte and 4 MB." }, 413);
      }

      const res = await fetch(uploadUrl, {
        method: "POST",
        headers: {
          "X-Goog-Upload-Offset": offset,
          "X-Goog-Upload-Command": command,
          "Content-Length": String(body.byteLength),
        },
        body,
      });
      const text = await res.text();
      return new Response(text, {
        status: res.status,
        headers: { "Content-Type": res.headers.get("content-type") || "application/json", "Cache-Control": "no-store" },
      });
    }

    if (action === "status") {
      const body = await request.json();
      const name = String(body?.name || "");
      if (!/^files\/[a-zA-Z0-9-]+$/.test(name)) return json({ ok: false, error: "Invalid Gemini file name." }, 400);
      const res = await fetch(`${GEMINI_API_BASE}/${name}?key=${encodeURIComponent(key)}`);
      const data = await res.json();
      return json(data, res.status);
    }


    if (action === "analyze") {
      const body = await request.json();
      const fileRef = body?.fileRef;
      const prompt = String(body?.prompt || "");
      if (!fileRef?.uri || !prompt) return json({ ok: false, error: "Missing Gemini file or prompt." }, 400);

      const res = await fetch(
        `${GEMINI_API_BASE}/models/gemini-2.5-flash-lite:generateContent?key=${encodeURIComponent(key)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [
              { text: prompt },
              { file_data: { mime_type: fileRef.mimeType || "video/mp4", file_uri: fileRef.uri } },
            ] }],
            generationConfig: { temperature: 0.55, maxOutputTokens: 12000, responseMimeType: "application/json" },
          }),
        }
      );
      const data = await res.json();
      return json(data, res.status);
    }

    return json({ ok: false, error: "Unsupported action." }, 400);
  } catch (error) {
    console.error("[creatorflow-gemini]", error);
    return json({ ok: false, error: "Gemini server operation failed." }, 500);
  }
}
