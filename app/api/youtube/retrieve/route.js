const DEFAULT_QUALITY = "720";

function json(data, status = 200) {
  return Response.json(data, {
    status,
    headers: { "Cache-Control": "no-store, max-age=0" },
  });
}

function normalizeYouTubeUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw.startsWith("http") ? raw : `https://${raw}`);
    const host = url.hostname.replace(/^www\./, "").toLowerCase();
    let id = "";
    if (host === "youtu.be") id = url.pathname.slice(1).split("/")[0];
    else if (host === "youtube.com" || host === "m.youtube.com") {
      if (url.pathname === "/watch") id = url.searchParams.get("v") || "";
      else if (url.pathname.startsWith("/shorts/")) id = url.pathname.split("/")[2] || "";
      else if (url.pathname.startsWith("/embed/")) id = url.pathname.split("/")[2] || "";
    }
    return /^[A-Za-z0-9_-]{11}$/.test(id) ? `https://www.youtube.com/watch?v=${id}` : "";
  } catch {
    return "";
  }
}

function getRetrieverConfig() {
  const endpoint = String(process.env.YOUTUBE_RETRIEVER_URL || "").trim().replace(/\/$/, "");
  const auth = String(process.env.YOUTUBE_RETRIEVER_AUTH || "").trim();
  const token = String(process.env.YOUTUBE_RETRIEVER_API_KEY || "").trim();
  return { endpoint, auth, token };
}

function authHeaders(auth, token) {
  if (!token) return {};
  if (auth.toLowerCase() === "bearer") return { Authorization: `Bearer ${token}` };
  if (auth.toLowerCase() === "api-key") return { Authorization: `Api-Key ${token}` };
  return { Authorization: token };
}

export async function POST(request) {
  try {
    const body = await request.json();
    const youtubeUrl = normalizeYouTubeUrl(body?.youtubeUrl);
    if (!youtubeUrl) return json({ ok: false, error: "Invalid YouTube URL." }, 400);

    const { endpoint, auth, token } = getRetrieverConfig();
    if (!endpoint) {
      return json({
        ok: false,
        error: "YouTube media retrieval is not configured. Set YOUTUBE_RETRIEVER_URL in Vercel to your Cobalt-compatible media retriever endpoint.",
      }, 503);
    }

    const upstream = await fetch(endpoint, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        ...authHeaders(auth, token),
      },
      body: JSON.stringify({
        url: youtubeUrl,
        videoQuality: String(body?.quality || DEFAULT_QUALITY),
        youtubeVideoCodec: "h264",
        youtubeVideoContainer: "mp4",
        downloadMode: "auto",
        alwaysProxy: true,
        disableMetadata: false,
      }),
      cache: "no-store",
    });

    const data = await upstream.json().catch(() => ({}));
    if (!upstream.ok) {
      return json({ ok: false, error: data?.error?.context?.message || data?.error?.code || `YouTube retriever failed (${upstream.status}).` }, 502);
    }

    let mediaUrl = "";
    if (data?.status === "redirect" || data?.status === "tunnel") mediaUrl = String(data?.url || "");
    else if (data?.status === "picker") {
      const video = Array.isArray(data?.picker) ? data.picker.find((item) => item?.type === "video" && item?.url) : null;
      mediaUrl = String(video?.url || "");
    } else {
      mediaUrl = String(data?.download_url || data?.downloadUrl || data?.url || "");
    }

    if (!/^https?:\/\//i.test(mediaUrl)) {
      return json({ ok: false, error: data?.error?.code || "The YouTube retriever did not return a downloadable video URL." }, 502);
    }

    return json({
      ok: true,
      youtubeUrl,
      mediaUrl,
      title: String(data?.title || data?.filename || "YouTube video"),
      provider: "cobalt-compatible",
    });
  } catch (error) {
    console.error("[creatorflow-youtube]", error);
    return json({ ok: false, error: "YouTube media retrieval failed. Check the retriever configuration and try again." }, 500);
  }
}
