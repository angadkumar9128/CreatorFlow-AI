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

export async function retrieveYouTubeVideo(youtubeUrl, options = {}) {
  const normalizedUrl = normalizeYouTubeUrl(youtubeUrl);
  if (!normalizedUrl) throw new Error("Enter a valid public YouTube URL.");

  options.onProgress?.({ stage: "retrieving", ratio: 0.1 });
  const setup = await fetch("/api/youtube/retrieve", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ youtubeUrl: normalizedUrl, quality: "720" }),
  });
  const data = await setup.json().catch(() => ({}));
  if (!setup.ok || !data?.mediaUrl) throw new Error(data?.error || "Could not retrieve the YouTube video.");

  options.onProgress?.({ stage: "downloading", ratio: 0.25 });
  const media = await fetch(data.mediaUrl);
  if (!media.ok) throw new Error(`Retrieved YouTube media could not be downloaded (${media.status}).`);
  const blob = await media.blob();
  if (!blob.size) throw new Error("The YouTube retriever returned an empty video.");

  options.onProgress?.({ stage: "finishing", ratio: 1 });
  const type = blob.type || "video/mp4";
  const file = new File([blob], "youtube-source.mp4", { type });
  return {
    file,
    youtubeUrl: normalizedUrl,
    title: data.title || "YouTube video",
    provider: data.provider || "media retriever",
  };
}
