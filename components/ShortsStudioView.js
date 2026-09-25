"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createRandomShorts, createRegularShorts, createAIShorts, DEFAULT_SHORT_SECONDS, formatTime, MAX_EDIT_SECONDS, MIN_EDIT_SECONDS, validateSourceDuration } from "@/lib/shorts-studio";
import { exportShort } from "@/lib/shorts-export";
import { saveFile } from "@/lib/download";
import { analyzeVideoForCreator } from "@/lib/ai-shorts";
import { retrieveYouTubeVideo } from "@/lib/youtube-retrieval";

const musicState = (file, url, duration) => ({ file, url, duration, start: 0, mode: "trim", volume: 1 });

export default function ShortsStudioView() {
  const sourceRef = useRef(null);
  const sourceUrlRef = useRef(null);
  const musicUrlsRef = useRef(new Set());
  const [sourceUrl, setSourceUrl] = useState("");
  const [sourceMode, setSourceMode] = useState("upload");
  const [youtubeUrl, setYoutubeUrl] = useState("");
  const [meta, setMeta] = useState(null);
  const [error, setError] = useState("");
  const [mode, setMode] = useState("regular");
  const [shortLength, setShortLength] = useState(String(DEFAULT_SHORT_SECONDS));
  const [shorts, setShorts] = useState([]);
  const [notice, setNotice] = useState("");
  const [batch, setBatch] = useState(false);
  const [creatorHandle, setCreatorHandle] = useState("");
  const [handlePosition, setHandlePosition] = useState("bottom-right");
  const [handleOpacity, setHandleOpacity] = useState(0.9);
  const [aiLoading, setAiLoading] = useState(false);
  const [youtubeLoading, setYoutubeLoading] = useState(false);
  const [aiProgress, setAiProgress] = useState(0);
  const [aiResult, setAiResult] = useState(null);

  const revokeSource = useCallback(() => {
    if (sourceUrlRef.current) URL.revokeObjectURL(sourceUrlRef.current);
    sourceUrlRef.current = null;
  }, []);

  useEffect(() => () => {
    revokeSource();
    musicUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
  }, [revokeSource]);

  function uploadSource(file) {
    setSourceMode("upload");
    setError(""); setNotice(""); setShorts([]); setMeta(null); setAiResult(null);
    if (!file) return;
    if (!file.type.startsWith("video/")) return setError("Please upload a video file.");
    revokeSource();
    const url = URL.createObjectURL(file);
    sourceRef.current = file; sourceUrlRef.current = url; setSourceUrl(url);
    const video = document.createElement("video");
    video.preload = "metadata"; video.src = url;
    video.onloadedmetadata = () => {
      const check = validateSourceDuration(video.duration);
      if (!check.ok) {
        sourceRef.current = null; revokeSource(); setSourceUrl(""); setError(check.error); return;
      }
      setMeta({ name: file.name, size: file.size, duration: video.duration, width: video.videoWidth, height: video.videoHeight });
    };
    video.onerror = () => { sourceRef.current = null; revokeSource(); setSourceUrl(""); setError("The browser could not read this video."); };
  }

  async function loadSourceFile(file, sourceName, sourceType = "upload", youtubeSource = "") {
    if (!file) throw new Error("No video source was returned.");
    revokeSource();
    const url = URL.createObjectURL(file);
    sourceRef.current = file;
    sourceUrlRef.current = url;
    setSourceUrl(url);
    const video = document.createElement("video");
    video.preload = "metadata";
    video.src = url;
    return await new Promise((resolve, reject) => {
      video.onloadedmetadata = () => {
        const check = validateSourceDuration(video.duration);
        if (!check.ok) {
          sourceRef.current = null;
          revokeSource();
          setSourceUrl("");
          reject(new Error(check.error));
          return;
        }
        const nextMeta = {
          name: sourceName || file.name || "Video source",
          size: file.size,
          duration: video.duration,
          width: video.videoWidth,
          height: video.videoHeight,
          sourceType,
          youtubeUrl: youtubeSource || "",
        };
        setMeta(nextMeta);
        resolve(nextMeta);
      };
      video.onerror = () => {
        sourceRef.current = null;
        revokeSource();
        setSourceUrl("");
        reject(new Error("The browser could not read the retrieved video."));
      };
    });
  }

  async function runYouTubeStudio() {
    const input = youtubeUrl.trim();
    if (!input) return setError("Paste a public YouTube URL first.");
    setYoutubeLoading(true);
    setAiLoading(false);
    setAiProgress(0);
    setError("");
    setNotice("Retrieving the YouTube video…");
    setShorts([]);
    setAiResult(null);
    try {
      const result = await retrieveYouTubeVideo(input, {
        onProgress: ({ ratio = 0, stage }) => {
          setAiProgress(ratio);
          setNotice(stage === "retrieving" ? "Connecting to the YouTube media retriever…" : stage === "downloading" ? "Downloading the source video…" : "Preparing the video in CreatorFlow-AI…");
        },
      });
      const nextMeta = await loadSourceFile(result.file, result.title, "youtube", result.youtubeUrl);
      const length = Math.min(DEFAULT_SHORT_SECONDS, nextMeta.duration);
      const generated = createRegularShorts(nextMeta.duration, length);
      if (!generated.length) throw new Error("The retrieved YouTube video is too short to create Shorts.");
      setShorts(generated);
      setMode("regular");
      setNotice(`YouTube video retrieved successfully. Created ${generated.length} editable Shorts. Export works like an uploaded video.`);
    } catch (e) {
      setError(e?.message || "YouTube video retrieval failed.");
    } finally {
      setYoutubeLoading(false);
      setAiProgress(1);
    }
  }

  async function runYouTubeAIStudio() {
    const input = youtubeUrl.trim();
    if (!input) return setError("Paste a public YouTube URL first.");
    setYoutubeLoading(true);
    setAiLoading(true);
    setAiProgress(0);
    setError("");
    setNotice("Retrieving the YouTube source for AI Auto Shorts…");
    setShorts([]);
    setAiResult(null);
    try {
      const result = await retrieveYouTubeVideo(input, {
        onProgress: ({ ratio = 0, stage }) => {
          setAiProgress(ratio * 0.35);
          setNotice(stage === "retrieving" ? "Connecting to the YouTube media retriever…" : stage === "downloading" ? "Downloading the source video…" : "Preparing the source for AI…");
        },
      });
      const nextMeta = await loadSourceFile(result.file, result.title, "youtube", result.youtubeUrl);

      let providerKeys = {};
      try { providerKeys = JSON.parse(localStorage.getItem("creatorflow-provider-keys-v1") || "{}"); } catch {}
      let geminiKey = String(providerKeys.geminiApiKey || "").trim();
      if (!geminiKey) {
        const status = await fetch("/api/ai/gemini?action=status", { cache: "no-store" });
        const data = await status.json().catch(() => ({}));
        if (!data.configured) throw new Error("AI Auto Shorts needs a Gemini key. Add your own key in AI Providers, or configure GEMINI_API_KEY in Vercel.");
        setNotice("Source retrieved. Gemini is analyzing it for AI Auto Shorts…");
      }

      const ai = await analyzeVideoForCreator(result.file, geminiKey, nextMeta.duration, {
        maxClips: 8,
        onProgress: ({ ratio = 0, stage }) => {
          setAiProgress(0.35 + ratio * 0.65);
          setNotice(stage === "uploading" ? "Uploading the YouTube source to Gemini…" : stage === "processing" ? "Gemini is processing the source…" : stage === "analyzing" ? "Gemini is finding the strongest moments…" : "Finishing AI Auto Shorts…");
        },
      });
      const generated = createAIShorts(nextMeta.duration, ai.clips);
      const withAI = generated.map((item) => ({
        ...item,
        captions: ai.captions.filter((caption) => caption.end > item.videoStart && caption.start < item.videoEnd),
        hooks: ai.hooks || [],
      }));
      if (!withAI.length) throw new Error("Gemini could not find usable Shorts in this YouTube video.");
      setShorts(withAI);
      setAiResult(ai);
      setMode("ai");
      setNotice(`AI created ${withAI.length} Shorts from the retrieved YouTube source. You can edit and export them normally.`);
    } catch (e) {
      setError(e?.message || "YouTube AI Auto Shorts failed.");
    } finally {
      setYoutubeLoading(false);
      setAiLoading(false);
      setAiProgress(1);
    }
  }

  async function runAIStudio() {
    if (!sourceRef.current || !meta) return setError("Upload a valid source video first.");
    let providerKeys = {};
    try { providerKeys = JSON.parse(localStorage.getItem("creatorflow-provider-keys-v1") || "{}"); } catch {}
    const ownGeminiKey = String(providerKeys.geminiApiKey || "").trim();
    let geminiKey = ownGeminiKey;
    if (!geminiKey) {
      try {
        const status = await fetch("/api/ai/gemini?action=status", { cache: "no-store" });
        const data = await status.json();
        if (!data.configured) {
          return setError("No Gemini key is configured. Add your own key in AI Providers, or configure GEMINI_API_KEY in Vercel.");
        }
        setNotice("Using the app's Vercel Gemini key. Add your own key in AI Providers anytime to use your own quota.");
      } catch {
        return setError("Could not check the app Gemini configuration. Add your own Gemini key in AI Providers.");
      }
    }
    setAiLoading(true); setAiProgress(0); setError(""); setNotice((current) => current || "");
    try {
      const result = await analyzeVideoForCreator(sourceRef.current, geminiKey, meta.duration, {
        maxClips: 8,
        onProgress: ({ ratio = 0, stage }) => {
          setAiProgress(ratio);
          setNotice(stage === "uploading" ? "Uploading video to Gemini…" : stage === "processing" ? "Gemini is processing the video…" : stage === "analyzing" ? "AI is finding the strongest moments, captions and hooks…" : "Finishing AI analysis…");
        },
      });
      const generated = createAIShorts(meta.duration, result.clips);
      const withAI = generated.map((item) => ({
        ...item,
        captions: result.captions.filter((caption) => caption.end > item.videoStart && caption.start < item.videoEnd),
        hooks: result.hooks || [],
      }));
      if (!withAI.length) throw new Error("Gemini could not find usable Shorts in this video. Try a video with clear speech or a stronger story.");
      setShorts(withAI);
      setAiResult(result);
      setMode("ai");
      setNotice(`AI created ${withAI.length} Shorts with captions and hook ideas. You can edit every Short normally.`);
    } catch (e) {
      setError(e?.message || "AI analysis failed.");
    } finally {
      setAiLoading(false); setAiProgress(1);
    }
  }

  function generate(nextMode = mode) {
    if (!meta) return setError("Upload a valid source video first.");
    const parsedLength = Number(shortLength);
    const length = Math.max(MIN_EDIT_SECONDS, Math.min(MAX_EDIT_SECONDS, Number.isFinite(parsedLength) && parsedLength > 0 ? parsedLength : DEFAULT_SHORT_SECONDS));
    if (length > meta.duration) return setError("Short duration cannot be longer than the source.");
    const next = nextMode === "random"
      ? createRandomShorts(meta.duration, length, Date.now())
      : createRegularShorts(meta.duration, length);
    setMode(nextMode); setShorts(next); setAiResult(null); setError("");
    setNotice(next.length ? `${next.length} Shorts created. Editing does not encode the source.` : "No Shorts could be created.");
  }

  function patch(id, changes) {
    setShorts((prev) => prev.map((item) => {
      if (item.id !== id) return item;
      const next = { ...item, ...changes };
      next.duration = Math.max(.05, next.videoEnd - next.videoStart);
      if (next.music) next.music = { ...next.music, start: Math.min(next.music.start, Math.max(0, next.music.duration - next.duration)) };
      if ("videoStart" in changes || "videoEnd" in changes || "originalVolume" in changes) {
        next.renderStatus = "idle"; next.renderProgress = 0; next.renderedBlob = null;
        if (next.outputUrl) URL.revokeObjectURL(next.outputUrl);
        next.outputUrl = null;
      }
      return next;
    }));
  }

  function expandEarlier(item) {
    if (!meta || item.sourceStart <= 0) return;
    patch(item.id, { sourceStart: 0 });
    setNotice(`Short #${item.index} can now start earlier from the original video.`);
  }

  function removeShort(id) {
    setShorts((prev) => prev.filter((item) => item.id !== id));
  }

  async function addMusic(id, file) {
    if (!file) return;
    if (!file.type.startsWith("audio/")) return setError("Please upload an audio file.");
    try {
      const url = URL.createObjectURL(file);
      musicUrlsRef.current.add(url);
      const duration = await getMediaDuration(url);
      patch(id, { music: musicState(file, url, duration) });
      setNotice(`Music added: ${file.name}`);
    } catch (e) { setError(e.message); }
  }

  function updateMusic(id, changes) {
    setShorts((prev) => prev.map((item) => {
      if (item.id !== id || !item.music) return item;
      const music = { ...item.music, ...changes };
      music.start = Math.max(0, Math.min(music.start, Math.max(0, music.duration - item.duration)));
      return { ...item, music, renderStatus: "idle", renderProgress: 0, renderedBlob: null, outputUrl: null };
    }));
  }

  function removeMusic(id) {
    setShorts((prev) => prev.map((item) => {
      if (item.id !== id) return item;
      if (item.music?.url) { URL.revokeObjectURL(item.music.url); musicUrlsRef.current.delete(item.music.url); }
      return { ...item, music: null, renderStatus: "idle", renderedBlob: null, outputUrl: null };
    }));
  }

  async function download(item) {
    if (!sourceRef.current) return;
    setShorts((prev) => prev.map((x) => x.id === item.id ? { ...x, renderStatus: "rendering", renderProgress: 0, error: "" } : x));
    try {
      const blob = await exportShort({
        sourceBlob: sourceRef.current,
        videoStart: item.videoStart,
        videoEnd: item.videoEnd,
        musicBlob: item.music?.file || null,
        musicStart: item.music?.start || 0,
        musicMode: item.music?.mode || "trim",
        musicVolume: item.music?.volume ?? 1,
        originalVolume: item.originalVolume ?? 1,
        creatorHandle: creatorHandle.trim(),
        handlePosition,
        handleOpacity,
        captions: item.captions || [],
        onProgress: (p) => setShorts((prev) => prev.map((x) => x.id === item.id ? { ...x, renderProgress: p.ratio || 0, renderStatus: p.stage === "converting" ? "converting" : "rendering" } : x)),
      });
      const url = URL.createObjectURL(blob);
      setShorts((prev) => prev.map((x) => x.id === item.id ? { ...x, renderStatus: "done", renderProgress: 1, renderedBlob: blob, outputUrl: url } : x));
      await saveFile(blob, `creatorflow-short-${String(item.index).padStart(2, "0")}-${Date.now()}`);
    } catch (e) {
      setShorts((prev) => prev.map((x) => x.id === item.id ? { ...x, renderStatus: "error", error: e.message } : x));
    }
  }

  async function downloadSelected() {
    const selected = shorts.filter((x) => x.selected);
    if (!selected.length) return setNotice("Select at least one Short.");
    setBatch(true);
    for (const item of selected) await download(item);
    setBatch(false);
    setNotice(`Finished ${selected.length} selected Shorts.`);
  }

  function reset(item) {
    patch(item.id, { videoStart: item.sourceStart, videoEnd: item.sourceEnd, music: null, originalVolume: 1, captions: [], hooks: [], title: "", description: "", hashtags: [], aiReason: "" });
  }

  return (
    <section className="shorts-studio">
      <div className="shorts-hero">
        <div className="shorts-source-card">
          <div className="panel-head"><span>01</span><div><h2>Source video</h2><p className="muted">Upload one video from 30 seconds to 30 minutes.</p></div></div>
          <div className="source-mode-tabs">
            <button className={sourceMode === "upload" ? "active" : ""} onClick={() => { setSourceMode("upload"); if (meta?.sourceType === "youtube") { revokeSource(); sourceRef.current = null; setSourceUrl(""); setMeta(null); setShorts([]); setAiResult(null); setYoutubeUrl(""); setNotice(""); } }}>Upload Video</button>
            <button className={sourceMode === "youtube" ? "active" : ""} onClick={() => setSourceMode("youtube")}>YouTube URL</button>
          </div>
          {sourceMode === "upload" ? (
            <div className="shorts-upload">
              <input type="file" accept="video/*" onChange={(e) => uploadSource(e.target.files?.[0])} />
              <span className="short-handle-note">30 seconds to 30 minutes. This source can be previewed, edited and exported in the browser.</span>
              {error && <div className="alert">{error}</div>}
            </div>
          ) : (
            <div className="shorts-upload youtube-source-box">
              <label>YouTube URL
                <input type="url" inputMode="url" placeholder="https://www.youtube.com/watch?v=..." value={youtubeUrl} onChange={(e) => setYoutubeUrl(e.target.value)} />
              </label>
              <div className="shorts-actions youtube-actions">
                <button className="primary-button" disabled={youtubeLoading || batch || !youtubeUrl.trim()} onClick={runYouTubeStudio}>
                  {youtubeLoading && !aiLoading ? `Retrieving ${Math.round(aiProgress * 100)}%` : "Create Shorts"}
                </button>
                <button className="secondary-button ai-action-button" disabled={youtubeLoading || batch || !youtubeUrl.trim()} onClick={runYouTubeAIStudio}>
                  {aiLoading ? `AI Auto Shorts ${Math.round(aiProgress * 100)}%` : "✨ AI Auto Shorts"}
                </button>
              </div>
              <span className="short-handle-note">Create Shorts retrieves the video first and uses the normal non-AI splitting/export pipeline. AI Auto Shorts is the only YouTube flow that sends the retrieved video to Gemini.</span>
              {error && <div className="alert">{error}</div>}
            </div>
          )}
          {sourceUrl && <video className="shorts-source-preview" src={sourceUrl} controls playsInline preload="metadata" />}
          {meta?.sourceType === "youtube" && meta.youtubeUrl && !sourceUrl && <div className="shorts-source-preview youtube-source-preview"><iframe src={youtubeEmbedUrl(meta.youtubeUrl)} title={meta.name || "YouTube video"} allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowFullScreen /></div>}
          {meta && <div className="shorts-source-meta">
            <Meta label="Source" value={meta.sourceType === "youtube" ? "YouTube" : meta.name} /><Meta label="Duration" value={formatTime(meta.duration)} />
            <Meta label="Resolution" value={meta.width && meta.height ? `${meta.width}×${meta.height}` : "YouTube player"} /><Meta label="Size" value={meta.size ? formatBytes(meta.size) : "Streaming"} />
            <Meta label="FPS" value={meta.sourceType === "youtube" ? "YouTube player" : "Browser metadata unavailable"} />
          </div>}
        </div>

        <div className="shorts-settings-card">
          <div className="panel-head"><span>02</span><div><h2>Create Shorts</h2><p className="muted">Create lightweight clip definitions first. No encoding while editing.</p></div></div>
          <label>Split mode
            <div className="segmented-control">
              <button aria-pressed={mode === "regular"} onClick={() => setMode("regular")}>Regular</button>
              <button aria-pressed={mode === "random"} onClick={() => setMode("random")}>Random</button>
            </div>
          </label>
          <label>Short duration (seconds)
            <input type="number" inputMode="decimal" min={MIN_EDIT_SECONDS} max={MAX_EDIT_SECONDS} value={shortLength}
              onChange={(e) => setShortLength(e.target.value)}
              onBlur={() => {
                const n = Number(shortLength);
                setShortLength(String(Number.isFinite(n) && n >= MIN_EDIT_SECONDS ? Math.min(MAX_EDIT_SECONDS, n) : DEFAULT_SHORT_SECONDS));
              }} />
          </label>
          <label>Creator handle (optional)
            <input type="text" inputMode="text" maxLength={40} placeholder="@yourusername" value={creatorHandle}
              onChange={(e) => setCreatorHandle(e.target.value.slice(0, 40))} />
          </label>
          <div className="short-time-row">
            <label>Handle position
              <select value={handlePosition} onChange={(e) => setHandlePosition(e.target.value)}>
                <option value="bottom-right">Bottom right</option>
                <option value="bottom-left">Bottom left</option>
                <option value="center">Middle / Center</option>
                <option value="top-right">Top right</option>
                <option value="top-left">Top left</option>
              </select>
            </label>
            <label>Handle opacity {Math.round(handleOpacity * 100)}%
              <input type="range" min="0.35" max="1" step="0.05" value={handleOpacity} onChange={(e) => setHandleOpacity(Number(e.target.value))} />
            </label>
          </div>
          <div className="short-handle-note">Burned into the downloaded Short.</div>
          <div className="shorts-actions shorts-generate-actions">
            <button className="secondary-button ai-action-button" disabled={!meta || batch || aiLoading} onClick={runAIStudio}>
              {aiLoading ? `AI Analyzing ${Math.round(aiProgress * 100)}%` : "✨ AI Auto Shorts"}
            </button>
            <button className="primary-button" disabled={!meta || batch} onClick={() => generate()}>Generate Shorts</button>
            <button className="secondary-button" disabled={!meta || batch} onClick={() => generate("random")}>Regenerate Random</button>
          </div>
          <div className="short-disclaimer">Cropping or adding music does not guarantee copyright immunity. Use content you have rights to use. YouTube Create Shorts retrieves the source video without AI; Gemini is used only when AI Auto Shorts is explicitly selected.</div>
        </div>
      </div>

      {notice && <p className="preview-note">{notice}</p>}
      {aiResult && <section className="short-ai-results">
        <div className="short-ai-results-head"><div><strong>AI Creator Assistant</strong><span>Gemini analysis · clips + captions + hooks</span></div><button className="text-button" onClick={() => setAiResult(null)}>Hide</button></div>
        {aiResult.summary && <p className="muted">{aiResult.summary}</p>}
        <div className="short-hook-list">
          {(aiResult.hooks || []).map((hook, i) => <button key={i} className="short-hook-chip" onClick={() => navigator.clipboard?.writeText(hook.text)} title="Tap to copy">{hook.text}<small>{hook.style}</small></button>)}
        </div>
      </section>}
      {shorts.length > 0 && <div className="shorts-summary">
        <strong>{shorts.length} Shorts</strong>
        <div className="shorts-actions">
          <button className="secondary-button" disabled={batch} onClick={() => setShorts((p) => p.map((x) => ({ ...x, selected: true })))}>Select All</button>
          <button className="secondary-button" disabled={batch} onClick={() => setShorts((p) => p.map((x) => ({ ...x, selected: false })))}>Clear Selection</button>
          <button className="secondary-button" disabled={batch} onClick={downloadSelected}>Download Selected</button>
        </div>
      </div>}

      <div className="shorts-list">
        {shorts.map((item) => <ShortCard key={item.id} item={item} sourceUrl={sourceUrl} sourceType={meta?.sourceType || "upload"} youtubeUrl={meta?.youtubeUrl || ""} sourceDuration={meta?.duration || 0} expandEarlier={expandEarlier} creatorHandle={creatorHandle} handlePosition={handlePosition} handleOpacity={handleOpacity} batch={batch} patch={patch} reset={reset} remove={removeShort} addMusic={addMusic} updateMusic={updateMusic} removeMusic={removeMusic} download={download} toggleSelect={(id) => setShorts((p) => p.map((x) => x.id === id ? { ...x, selected: !x.selected } : x))} />)}
      </div>
    </section>
  );
}

function Meta({ label, value }) {
  return <div className="shorts-meta-item"><span>{label}</span><strong title={value}>{value}</strong></div>;
}

function ShortCard({ item, sourceUrl, sourceType, youtubeUrl, sourceDuration, expandEarlier, creatorHandle, handlePosition, handleOpacity, batch, patch, reset, remove, addMusic, updateMusic, removeMusic, download, toggleSelect }) {
  const videoRef = useRef(null);
  const musicRef = useRef(null);
  const [playing, setPlaying] = useState(false);
  const [activeCaption, setActiveCaption] = useState("");
  const activeHandleRef = useRef(null);
  const [startDraft, setStartDraft] = useState(item.videoStart.toFixed(1));
  const [endDraft, setEndDraft] = useState(item.videoEnd.toFixed(1));

  useEffect(() => {
    setStartDraft(item.videoStart.toFixed(1));
    setEndDraft(item.videoEnd.toFixed(1));
    const video = videoRef.current;
    if (!video) return;
    video.volume = Math.max(0, Math.min(1, item.originalVolume ?? 1));
    video.pause(); video.currentTime = item.videoStart; setPlaying(false);
    if (musicRef.current && item.music) { musicRef.current.pause(); musicRef.current.currentTime = item.music.start; }
  }, [item.videoStart, item.videoEnd, item.music, item.originalVolume]);

  function play() {
    const video = videoRef.current;
    if (!video) return;
    if (playing) { video.pause(); musicRef.current?.pause(); setPlaying(false); return; }
    video.currentTime = item.videoStart;
    if (musicRef.current && item.music) musicRef.current.currentTime = item.music.start;
    Promise.all([video.play(), item.music ? musicRef.current?.play() : Promise.resolve()]).then(() => setPlaying(true)).catch(() => setPlaying(false));
  }

  useEffect(() => {
    const video = videoRef.current;
    if (video) video.volume = Math.max(0, Math.min(1, Number(item.originalVolume) || 0));
    const audio = musicRef.current;
    if (audio && item.music) audio.volume = Math.max(0, Math.min(1, Number(item.music.volume) || 0));
  }, [item.originalVolume, item.music]);

  useEffect(() => {
    const audio = musicRef.current;
    if (!audio || !item.music || item.music.mode !== "loop") return;
    const onEnded = () => { audio.currentTime = item.music.start; audio.play().catch(() => {}); };
    audio.addEventListener("ended", onEnded);
    return () => audio.removeEventListener("ended", onEnded);
  }, [item.music]);

  function timeUpdate() {
    const video = videoRef.current;
    if (!video || !playing) return;
    const caption = (item.captions || []).find((entry) => video.currentTime >= entry.start && video.currentTime < entry.end);
    setActiveCaption(caption?.text || "");
    if (video.currentTime >= item.videoEnd - .04) {
      video.pause(); musicRef.current?.pause(); video.currentTime = item.videoStart; setPlaying(false);
    }
  }

  const span = Math.max(.001, item.sourceEnd - item.sourceStart);
  const left = ((item.videoStart - item.sourceStart) / span) * 100;
  const width = ((item.videoEnd - item.videoStart) / span) * 100;
  const musicMax = item.music ? Math.max(0, item.music.duration - item.duration) : 0;
  const musicWidth = item.music ? Math.min(100, item.duration / item.music.duration * 100) : 0;
  const musicLeft = item.music ? item.music.start / item.music.duration * 100 : 0;

  const setStart = (v) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return;
    const nextStart = Math.max(0, Math.min(n, item.videoEnd - MIN_EDIT_SECONDS));
    const nextSourceStart = nextStart < item.sourceStart ? 0 : item.sourceStart;
    patch(item.id, { sourceStart: nextSourceStart, videoStart: nextStart });
  };
  const setEnd = (v) => patch(item.id, { videoEnd: Math.min(item.sourceEnd, Math.max(Number(v), item.videoStart + MIN_EDIT_SECONDS)) });

  function setTimelineFromPointer(clientX, handle) {
    const target = document.getElementById(`short-timeline-${item.id}`);
    if (!target) return;
    const rect = target.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(1, rect.width)));
    const value = item.sourceStart + ratio * (item.sourceEnd - item.sourceStart);
    if (handle === "start") setStart(value);
    else setEnd(value);
  }

  function timelinePointerDown(event) {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / Math.max(1, rect.width)));
    const value = item.sourceStart + ratio * (item.sourceEnd - item.sourceStart);
    const startDistance = Math.abs(value - item.videoStart);
    const endDistance = Math.abs(value - item.videoEnd);
    const handle = startDistance <= endDistance ? "start" : "end";
    activeHandleRef.current = handle;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setTimelineFromPointer(event.clientX, handle);
  }

  function timelinePointerMove(event) {
    if (!activeHandleRef.current) return;
    event.preventDefault();
    setTimelineFromPointer(event.clientX, activeHandleRef.current);
  }

  function timelinePointerUp(event) {
    activeHandleRef.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  }

  return (
    <article className="short-card">
      <div className="short-card-top">
        <div className="short-card-mobile-actions"><button className="secondary-button" disabled={batch || sourceType === "youtube"} onClick={() => download(item)}>{sourceType === "youtube" ? "Upload to Export" : item.renderStatus === "done" ? "Export again" : "Export"}</button></div>
        <div className="short-title"><input type="checkbox" checked={!!item.selected} onChange={() => toggleSelect(item.id)} /><span className="short-number">{item.index}</span><div><strong>Short #{item.index}</strong><div className="muted">{formatTime(item.videoStart)} → {formatTime(item.videoEnd)} · {item.duration.toFixed(1)}s</div></div></div>
        <div className="shorts-actions"><button className="text-button" disabled={batch} onClick={() => reset(item)}>Reset</button><button className="text-button" disabled={batch} onClick={() => remove(item.id)}>Delete</button></div>
      </div>

      <div className="short-card-main">
        <div className="short-card-preview">
          {sourceType === "youtube" && youtubeUrl
            ? <iframe className="short-youtube-frame" src={youtubeEmbedUrl(youtubeUrl, item.videoStart, item.videoEnd)} title={`YouTube Short #${item.index}`} allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowFullScreen />
            : <video ref={videoRef} src={sourceUrl} muted={false} volume={item.originalVolume ?? 1} playsInline preload="metadata" onTimeUpdate={timeUpdate} />}
          {item.music && <audio ref={musicRef} src={item.music.url} preload="metadata" />}
          {activeCaption && <div className="short-preview-caption">{activeCaption}</div>}
          {creatorHandle.trim() && <div className={`short-creator-handle ${handlePosition}`} style={{ opacity: handleOpacity }}>{creatorHandle.trim()}</div>}
          {sourceType !== "youtube" && <button className="short-play-button" onClick={play}>{playing ? "Pause" : "Preview"}</button>}
          {sourceType === "youtube" && <a className="short-play-button" href={youtubeUrl} target="_blank" rel="noreferrer">Open on YouTube</a>}
        </div>

        <div className="short-editor">
          <section className="short-section">
            <div className="short-section-head"><strong>Video timeline</strong><span>{formatTime(item.videoStart)} – {formatTime(item.videoEnd)}</span></div>
            <div
              id={`short-timeline-${item.id}`}
              className="short-timeline"
              onPointerDown={timelinePointerDown}
              onPointerMove={timelinePointerMove}
              onPointerUp={timelinePointerUp}
              onPointerCancel={timelinePointerUp}
            >
              <div className="short-timeline-track" />
              <div className="short-timeline-selected" style={{ left: `${left}%`, width: `${width}%` }} />
              <div className="short-timeline-handle start" style={{ left: `${left}%` }} aria-hidden="true" />
              <div className="short-timeline-handle end" style={{ left: `${left + width}%` }} aria-hidden="true" />
              <input aria-label={`Short ${item.index} start time`} type="range" min={item.sourceStart} max={item.videoEnd - MIN_EDIT_SECONDS} step=".1" value={item.videoStart} onChange={(e) => setStart(e.target.value)} />
              <input aria-label={`Short ${item.index} end time`} type="range" min={item.videoStart + MIN_EDIT_SECONDS} max={item.sourceEnd} step=".1" value={item.videoEnd} onChange={(e) => setEnd(e.target.value)} />
            </div>
            <div className="short-time-row">
              <label>Start<input type="number" inputMode="decimal" step=".1" min={item.sourceStart} max={item.videoEnd - MIN_EDIT_SECONDS} value={startDraft}
                onChange={(e) => setStartDraft(e.target.value)}
                onBlur={() => { const n = Number(startDraft); setStart(Number.isFinite(n) ? n : item.videoStart); }} /></label>
              <label>End<input type="number" inputMode="decimal" step=".1" min={item.videoStart + MIN_EDIT_SECONDS} max={item.sourceEnd} value={endDraft}
                onChange={(e) => setEndDraft(e.target.value)}
                onBlur={() => { const n = Number(endDraft); setEnd(Number.isFinite(n) ? n : item.videoEnd); }} /></label>
            </div>
            {item.sourceStart > 0 && <button className="text-button" disabled={batch || !sourceDuration} onClick={() => expandEarlier(item)}>← Extend start to original video</button>}
            {item.sourceStart > 0 && <div className="short-handle-note">Need an earlier moment? Extend this Short to the original video.</div>}
          </section>

          <section className="short-section">
            <div className="short-section-head"><strong>Music</strong><span>{item.music ? formatTime(item.music.duration) : "None"}</span></div>
            {!item.music ? <input type="file" accept="audio/*" onChange={(e) => addMusic(item.id, e.target.files?.[0])} /> : <>
              <div className="short-music-upload"><span className="muted">{item.music.file.name}</span><button className="text-button" onClick={() => removeMusic(item.id)}>Remove</button></div>
              <label>Music position<input type="range" min="0" max={musicMax} step=".1" value={Math.min(item.music.start, musicMax)} onChange={(e) => updateMusic(item.id, { start: Number(e.target.value) })} /></label>
              <div className="music-window"><span style={{ left: `${musicLeft}%`, width: `${musicWidth}%` }} /></div>
              <div className="short-handle-note">Slide to choose music start.</div>
              <div className="short-volume-row">
                  <label>Music volume {Math.round(item.music.volume * 100)}%
                  <input type="range" min="0" max="1" step=".05" value={item.music.volume} onChange={(e) => updateMusic(item.id, { volume: Number(e.target.value) })} />
                </label>
                <label>Original audio {Math.round((item.originalVolume ?? 1) * 100)}%
                  <input type="range" min="0" max="1" step=".05" value={item.originalVolume ?? 1}
                    onChange={(e) => {
                      const value = Number(e.target.value);
                      if (videoRef.current) videoRef.current.volume = value;
                      patch(item.id, { originalVolume: value });
                    }} />
                </label>
              </div>
              {item.music.duration < item.duration && <div className="segmented-control"><button aria-pressed={item.music.mode === "trim"} onClick={() => updateMusic(item.id, { mode: "trim" })}>Silence after song</button><button aria-pressed={item.music.mode === "loop"} onClick={() => updateMusic(item.id, { mode: "loop" })}>Loop music</button></div>}
            </>}
          </section>

          {item.hooks?.length > 0 && <section className="short-ai-hook-section"><strong>AI Hook ideas</strong><div className="short-hook-list">{item.hooks.slice(0, 3).map((hook, i) => <button key={i} className="short-hook-chip" onClick={() => navigator.clipboard?.writeText(hook.text)}>{hook.text}</button>)}</div></section>}
          {(item.title || item.description || item.hashtags?.length > 0) && (
            <section className="short-social-package">
              <div className="short-social-head">
                <div><strong>AI Instagram Caption</strong><span>Title + description + relevant discovery hashtags</span></div>
                <button className="secondary-button" onClick={() => {
                  const text = [item.title && `Title: ${item.title}`, item.description && `Description: ${item.description}`, item.hashtags?.length ? item.hashtags.join(" ") : ""].filter(Boolean).join("\n\n");
                  navigator.clipboard?.writeText(text);
                }}>Copy All</button>
              </div>
              {item.title && <div className="short-social-field"><small>Title</small><strong>{item.title}</strong></div>}
              {item.description && <div className="short-social-field"><small>Description</small><p>{item.description}</p></div>}
              {item.hashtags?.length > 0 && <div className="short-social-field"><small>Hashtags</small><p>{item.hashtags.join(" ")}</p></div>}
            </section>
          )}
          {item.captions?.length > 0 && <div className="short-handle-note">{sourceType === "youtube" ? "AI captions are available for this timestamp plan. Upload an authorized source video to burn them into an export." : "AI on-video captions are previewed now and burned into the downloaded Short."}</div>}
          {item.error && <div className="alert short-error">{item.error}</div>}
          <div className="short-status"><span className="short-status-text">{sourceType === "youtube" && "YouTube analysis mode; export requires an authorized local source video."}{sourceType !== "youtube" && item.renderStatus === "idle" && "Preview-only edits; final encoding happens on Download."}{item.renderStatus === "rendering" && `Rendering ${Math.round(item.renderProgress * 100)}%`}{item.renderStatus === "converting" && `Converting MP4 ${Math.round(item.renderProgress * 100)}%`}{item.renderStatus === "done" && "MP4 ready"}{item.renderStatus === "error" && "Export failed"}</span><button className="primary-button" disabled={batch || sourceType === "youtube" || item.renderStatus === "rendering" || item.renderStatus === "converting"} onClick={() => download(item)}>{sourceType === "youtube" ? "Upload to Export" : item.renderStatus === "done" ? "Download Again" : "Download Short"}</button></div>
        </div>
      </div>
    </article>
  );
}

function getMediaDuration(url) {
  const media = document.createElement("audio");
  media.preload = "metadata"; media.src = url;
  return new Promise((resolve, reject) => {
    const ok = () => { cleanup(); const value = Number(media.duration); if (value > 0) resolve(value); else reject(new Error("Music duration is unavailable.")); };
    const bad = () => { cleanup(); reject(new Error("Could not read the music duration.")); };
    const cleanup = () => { media.removeEventListener("loadedmetadata", ok); media.removeEventListener("error", bad); };
    media.addEventListener("loadedmetadata", ok, { once: true }); media.addEventListener("error", bad, { once: true });
  });
}

function formatBytes(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const exponent = Math.min(3, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** exponent).toFixed(exponent ? 1 : 0)} ${units[exponent]}`;
}


function youtubeEmbedUrl(value, start = 0, end = null) {
  const raw = String(value || "").trim();
  let id = "";
  try {
    const url = new URL(raw);
    const host = url.hostname.replace(/^www\./, "").toLowerCase();
    if (host === "youtu.be") id = url.pathname.slice(1).split("/")[0];
    else if (host === "youtube.com" || host === "m.youtube.com") {
      if (url.pathname === "/watch") id = url.searchParams.get("v") || "";
      else if (url.pathname.startsWith("/shorts/")) id = url.pathname.split("/")[2] || "";
      else if (url.pathname.startsWith("/embed/")) id = url.pathname.split("/")[2] || "";
    }
  } catch {}
  if (!/^[A-Za-z0-9_-]{11}$/.test(id)) return "https://www.youtube.com/embed/";
  const params = new URLSearchParams({ playsinline: "1", rel: "0", start: String(Math.max(0, Math.floor(Number(start) || 0))) });
  if (Number.isFinite(Number(end)) && Number(end) > Number(start)) params.set("end", String(Math.ceil(Number(end))));
  return `https://www.youtube.com/embed/${id}?${params.toString()}`;
}
