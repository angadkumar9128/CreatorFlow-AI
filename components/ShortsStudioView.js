"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createRandomShorts, createRegularShorts, DEFAULT_SHORT_SECONDS, formatTime, MAX_EDIT_SECONDS, MIN_EDIT_SECONDS, validateSourceDuration } from "@/lib/shorts-studio";
import { exportShort } from "@/lib/shorts-export";
import { saveFile } from "@/lib/download";

const musicState = (file, url, duration) => ({ file, url, duration, start: 0, mode: "trim", volume: 1 });

export default function ShortsStudioView() {
  const sourceRef = useRef(null);
  const sourceUrlRef = useRef(null);
  const musicUrlsRef = useRef(new Set());
  const [sourceUrl, setSourceUrl] = useState("");
  const [meta, setMeta] = useState(null);
  const [error, setError] = useState("");
  const [mode, setMode] = useState("regular");
  const [shortLength, setShortLength] = useState(DEFAULT_SHORT_SECONDS);
  const [shorts, setShorts] = useState([]);
  const [notice, setNotice] = useState("");
  const [batch, setBatch] = useState(false);

  const revokeSource = useCallback(() => {
    if (sourceUrlRef.current) URL.revokeObjectURL(sourceUrlRef.current);
    sourceUrlRef.current = null;
  }, []);

  useEffect(() => () => {
    revokeSource();
    musicUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
  }, [revokeSource]);

  function uploadSource(file) {
    setError(""); setNotice(""); setShorts([]); setMeta(null);
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

  function generate(nextMode = mode) {
    if (!meta) return setError("Upload a valid source video first.");
    const length = Math.max(MIN_EDIT_SECONDS, Math.min(MAX_EDIT_SECONDS, Number(shortLength) || DEFAULT_SHORT_SECONDS));
    if (length > meta.duration) return setError("Short duration cannot be longer than the source.");
    const next = nextMode === "random"
      ? createRandomShorts(meta.duration, length, Date.now())
      : createRegularShorts(meta.duration, length);
    setMode(nextMode); setShorts(next); setError("");
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
    patch(item.id, { videoStart: item.sourceStart, videoEnd: item.sourceEnd, music: null, originalVolume: 1 });
  }

  return (
    <section className="shorts-studio">
      <div className="shorts-hero">
        <div className="shorts-source-card">
          <div className="panel-head"><span>01</span><div><h2>Source video</h2><p className="muted">Upload one video from 30 seconds to 30 minutes.</p></div></div>
          <div className="shorts-upload">
            <input type="file" accept="video/*" onChange={(e) => uploadSource(e.target.files?.[0])} />
            {error && <div className="alert">{error}</div>}
          </div>
          {sourceUrl && <video className="shorts-source-preview" src={sourceUrl} controls playsInline preload="metadata" />}
          {meta && <div className="shorts-source-meta">
            <Meta label="File" value={meta.name} /><Meta label="Duration" value={formatTime(meta.duration)} />
            <Meta label="Resolution" value={`${meta.width}×${meta.height}`} /><Meta label="Size" value={formatBytes(meta.size)} />
            <Meta label="FPS" value="Browser metadata unavailable" />
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
            <input type="number" min={MIN_EDIT_SECONDS} max={MAX_EDIT_SECONDS} value={shortLength} onChange={(e) => setShortLength(Number(e.target.value) || DEFAULT_SHORT_SECONDS)} />
          </label>
          <div className="shorts-actions">
            <button className="primary-button" disabled={!meta || batch} onClick={() => generate()}>Generate Shorts</button>
            <button className="secondary-button" disabled={!meta || batch} onClick={() => generate("random")}>Regenerate Random</button>
          </div>
          <div className="short-disclaimer">Cropping or adding music does not guarantee copyright immunity. Use content you have rights to use.</div>
        </div>
      </div>

      {notice && <p className="preview-note">{notice}</p>}
      {shorts.length > 0 && <div className="shorts-summary">
        <strong>{shorts.length} Shorts</strong>
        <div className="shorts-actions">
          <button className="secondary-button" disabled={batch} onClick={() => setShorts((p) => p.map((x) => ({ ...x, selected: true })))}>Select All</button>
          <button className="secondary-button" disabled={batch} onClick={() => setShorts((p) => p.map((x) => ({ ...x, selected: false })))}>Clear Selection</button>
          <button className="secondary-button" disabled={batch} onClick={downloadSelected}>Download Selected</button>
        </div>
      </div>}

      <div className="shorts-list">
        {shorts.map((item) => <ShortCard key={item.id} item={item} sourceUrl={sourceUrl} batch={batch} patch={patch} reset={reset} remove={removeShort} addMusic={addMusic} updateMusic={updateMusic} removeMusic={removeMusic} download={download} toggleSelect={(id) => setShorts((p) => p.map((x) => x.id === id ? { ...x, selected: !x.selected } : x))} />)}
      </div>
    </section>
  );
}

function Meta({ label, value }) {
  return <div className="shorts-meta-item"><span>{label}</span><strong title={value}>{value}</strong></div>;
}

function ShortCard({ item, sourceUrl, batch, patch, reset, remove, addMusic, updateMusic, removeMusic, download, toggleSelect }) {
  const videoRef = useRef(null);
  const musicRef = useRef(null);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.pause(); video.currentTime = item.videoStart; setPlaying(false);
    if (musicRef.current && item.music) { musicRef.current.pause(); musicRef.current.currentTime = item.music.start; }
  }, [item.videoStart, item.videoEnd, item.music?.start]);

  function play() {
    const video = videoRef.current;
    if (!video) return;
    if (playing) { video.pause(); musicRef.current?.pause(); setPlaying(false); return; }
    video.currentTime = item.videoStart;
    if (musicRef.current && item.music) musicRef.current.currentTime = item.music.start;
    Promise.all([video.play(), item.music ? musicRef.current?.play() : Promise.resolve()]).then(() => setPlaying(true)).catch(() => setPlaying(false));
  }

  function timeUpdate() {
    const video = videoRef.current;
    if (!video || !playing) return;
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

  const setStart = (v) => patch(item.id, { videoStart: Math.max(item.sourceStart, Math.min(Number(v), item.videoEnd - MIN_EDIT_SECONDS)) });
  const setEnd = (v) => patch(item.id, { videoEnd: Math.min(item.sourceEnd, Math.max(Number(v), item.videoStart + MIN_EDIT_SECONDS)) });

  return (
    <article className="short-card">
      <div className="short-card-top">
        <div className="short-title"><input type="checkbox" checked={!!item.selected} onChange={() => toggleSelect(item.id)} /><span className="short-number">{item.index}</span><div><strong>Short #{item.index}</strong><div className="muted">{formatTime(item.videoStart)} → {formatTime(item.videoEnd)} · {item.duration.toFixed(1)}s</div></div></div>
        <div className="shorts-actions"><button className="text-button" disabled={batch} onClick={() => reset(item)}>Reset</button><button className="text-button" disabled={batch} onClick={() => remove(item.id)}>Delete</button></div>
      </div>

      <div className="short-card-main">
        <div className="short-card-preview">
          <video ref={videoRef} src={sourceUrl} muted={!item.music} playsInline preload="metadata" onTimeUpdate={timeUpdate} />
          {item.music && <audio ref={musicRef} src={item.music.url} preload="metadata" />}
          <button className="short-play-button" onClick={play}>{playing ? "Pause" : "Preview"}</button>
        </div>

        <div className="short-editor">
          <section className="short-section">
            <div className="short-section-head"><strong>Video timeline</strong><span>{formatTime(item.videoStart)} – {formatTime(item.videoEnd)}</span></div>
            <div className="short-timeline">
              <div className="short-timeline-track" />
              <div className="short-timeline-selected" style={{ left: `${left}%`, width: `${width}%` }} />
              <input type="range" min={item.sourceStart} max={item.videoEnd - MIN_EDIT_SECONDS} step=".1" value={item.videoStart} onChange={(e) => setStart(e.target.value)} />
              <input type="range" min={item.videoStart + MIN_EDIT_SECONDS} max={item.sourceEnd} step=".1" value={item.videoEnd} onChange={(e) => setEnd(e.target.value)} />
            </div>
            <div className="short-time-row"><label>Start<input type="number" step=".1" value={item.videoStart.toFixed(1)} onChange={(e) => setStart(e.target.value)} /></label><label>End<input type="number" step=".1" value={item.videoEnd.toFixed(1)} onChange={(e) => setEnd(e.target.value)} /></label></div>
          </section>

          <section className="short-section">
            <div className="short-section-head"><strong>Music</strong><span>{item.music ? `${item.music.duration.toFixed(1)}s` : "None"}</span></div>
            {!item.music ? <input type="file" accept="audio/*" onChange={(e) => addMusic(item.id, e.target.files?.[0])} /> : <>
              <div className="short-music-upload"><span className="muted">{item.music.file.name}</span><button className="text-button" onClick={() => removeMusic(item.id)}>Remove</button></div>
              <label>Music position<input type="range" min="0" max={musicMax} step=".1" value={Math.min(item.music.start, musicMax)} onChange={(e) => updateMusic(item.id, { start: Number(e.target.value) })} /></label>
              <div className="music-window"><span style={{ left: `${musicLeft}%`, width: `${musicWidth}%` }} /></div>
              <div className="short-volume-row">
                <label>Music volume {Math.round(item.music.volume * 100)}%<input type="range" min="0" max="1" step=".05" value={item.music.volume} onChange={(e) => updateMusic(item.id, { volume: Number(e.target.value) })} /></label>
                <label>Original audio {Math.round((item.originalVolume ?? 1) * 100)}%<input type="range" min="0" max="1" step=".05" value={item.originalVolume ?? 1} onChange={(e) => patch(item.id, { originalVolume: Number(e.target.value) })} /></label>
              </div>
              {item.music.duration < item.duration && <div className="segmented-control"><button aria-pressed={item.music.mode === "trim"} onClick={() => updateMusic(item.id, { mode: "trim" })}>Silence after song</button><button aria-pressed={item.music.mode === "loop"} onClick={() => updateMusic(item.id, { mode: "loop" })}>Loop music</button></div>}
            </>}
          </section>

          {item.error && <div className="alert short-error">{item.error}</div>}
          <div className="short-status"><span className="short-status-text">{item.renderStatus === "idle" && "Preview-only edits; final encoding happens on Download."}{item.renderStatus === "rendering" && `Rendering ${Math.round(item.renderProgress * 100)}%`}{item.renderStatus === "converting" && `Converting MP4 ${Math.round(item.renderProgress * 100)}%`}{item.renderStatus === "done" && "MP4 ready"}{item.renderStatus === "error" && "Export failed"}</span><button className="primary-button" disabled={batch || item.renderStatus === "rendering" || item.renderStatus === "converting"} onClick={() => download(item)}>{item.renderStatus === "done" ? "Download Again" : "Download Short"}</button></div>
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
