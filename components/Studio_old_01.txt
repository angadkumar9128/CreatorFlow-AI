"use client";

/* eslint-disable @next/next/no-img-element */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { NICHES } from "@/lib/prompt";
import { W, H, THEMES, loadImage, timeline, drawFrame, recordReel } from "@/lib/render";

const IMAGE_W = 1080;
const IMAGE_H = 1350;

const NAV_ITEMS = ["Dashboard", "Generate", "My Content", "Calendar", "Analytics", "AI Providers", "Settings"];
const TYPES = [
  { id: "video", label: "Reel", note: "10-60s vertical reel from generated scenes" },
  { id: "image", label: "Image", note: "1080x1350 feed post or cover image" },
  { id: "meme", label: "Meme", note: "AI visual with editable top and bottom text" },
];
const LANGUAGES = ["English", "Hindi", "Hinglish"];
const CREATOR_STYLES = [
  { id: "viral", label: "Viral", tone: "punchy", image: "vibrant", theme: "bold" },
  { id: "educational", label: "Educational", tone: "authority", image: "editorial", theme: "cool" },
  { id: "funny", label: "Funny", tone: "funny", image: "illustrated", theme: "bold" },
  { id: "premium", label: "Premium", tone: "authority", image: "editorial", theme: "warm" },
  { id: "cinematic", label: "Cinematic", tone: "calm", image: "moody", theme: "warm" },
  { id: "fast", label: "Fast", tone: "punchy", image: "vibrant", theme: "bold" },
  { id: "creative", label: "Creative", tone: "punchy", image: "illustrated", theme: "cool" },
  { id: "emotional", label: "Emotional", tone: "calm", image: "photoreal", theme: "warm" },
  { id: "news", label: "News", tone: "authority", image: "editorial", theme: "mono" },
  { id: "auto", label: "Auto", tone: "punchy", image: "photoreal", theme: "bold" },
];

const STORAGE_KEY = "creatorflow-history-v1";
const PROVIDER_KEY = "creatorflow-provider-keys-v1";
const SETTINGS_KEY = "creatorflow-settings-v1";
const SCHEDULE_KEY = "creatorflow-schedule-v1";

const todayLabel = () =>
  new Date().toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long" });

const emptyMeme = { top: "", bottom: "" };
const emptyProviderKeys = {
  groqApiKey: "",
  geminiApiKey: "",
  openrouterApiKey: "",
  cerebrasApiKey: "",
  cloudflareAccountId: "",
  cloudflareApiToken: "",
  togetherApiKey: "",
  pollinationsToken: "",
};
const defaultSettings = {
  textProvider: "auto",
  imageProvider: "auto",
  soundEnabled: true,
  soundVolume: 0.22,
  appTheme: "dark",
};

function cleanTags(tags) {
  if (Array.isArray(tags)) return tags.map((tag) => String(tag).trim()).filter(Boolean);
  return String(tags || "")
    .split(/\s+/)
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function wrapLines(ctx, text, maxWidth) {
  const words = String(text || "").split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";

  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = word;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function drawCover(ctx, img, width, height) {
  const ratio = Math.max(width / img.width, height / img.height);
  const w = img.width * ratio;
  const h = img.height * ratio;
  ctx.drawImage(img, (width - w) / 2, (height - h) / 2, w, h);
}

function drawStaticPost(ctx, img, { plan, type, handle, meme }) {
  ctx.fillStyle = "#071315";
  ctx.fillRect(0, 0, IMAGE_W, IMAGE_H);
  drawCover(ctx, img, IMAGE_W, IMAGE_H);

  const top = ctx.createLinearGradient(0, 0, 0, 360);
  top.addColorStop(0, "rgba(0,0,0,0.72)");
  top.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = top;
  ctx.fillRect(0, 0, IMAGE_W, 360);

  const bottom = ctx.createLinearGradient(0, IMAGE_H, 0, IMAGE_H - 520);
  bottom.addColorStop(0, "rgba(0,0,0,0.82)");
  bottom.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = bottom;
  ctx.fillRect(0, IMAGE_H - 520, IMAGE_W, 520);

  ctx.textAlign = "center";
  ctx.lineJoin = "round";

  if (type === "meme") {
    ctx.font = '900 82px "Bricolage Grotesque", Impact, sans-serif';
    ctx.strokeStyle = "rgba(0,0,0,0.88)";
    ctx.lineWidth = 14;
    ctx.fillStyle = "#ffffff";

    const topLines = wrapLines(ctx, meme.top || plan.hook, IMAGE_W - 130).slice(0, 3);
    topLines.forEach((line, index) => {
      const y = 116 + index * 92;
      ctx.strokeText(line.toUpperCase(), IMAGE_W / 2, y);
      ctx.fillText(line.toUpperCase(), IMAGE_W / 2, y);
    });

    const bottomLines = wrapLines(ctx, meme.bottom || plan.title, IMAGE_W - 130).slice(0, 3);
    bottomLines.forEach((line, index) => {
      const y = IMAGE_H - 190 + index * 92;
      ctx.strokeText(line.toUpperCase(), IMAGE_W / 2, y);
      ctx.fillText(line.toUpperCase(), IMAGE_W / 2, y);
    });
  } else {
    ctx.font = '800 72px "Bricolage Grotesque", sans-serif';
    ctx.strokeStyle = "rgba(0,0,0,0.62)";
    ctx.lineWidth = 12;
    ctx.fillStyle = "#ffffff";
    wrapLines(ctx, plan.title || plan.hook, IMAGE_W - 140)
      .slice(0, 4)
      .forEach((line, index) => {
        const y = IMAGE_H - 305 + index * 82;
        ctx.strokeText(line, IMAGE_W / 2, y);
        ctx.fillText(line, IMAGE_W / 2, y);
      });
  }

  if (handle) {
    ctx.font = '600 34px "Instrument Sans", sans-serif';
    ctx.fillStyle = "rgba(255,255,255,0.84)";
    ctx.fillText(handle, IMAGE_W / 2, IMAGE_H - 58);
  }
}

function sceneImagePrompt(scene, index, scenes, { categoryLabel, styleLabel, type }) {
  const previous = scenes[index - 1]?.onScreenText;
  const next = scenes[index + 1]?.onScreenText;
  return [
    scene.imagePrompt,
    `Scene ${index + 1} of ${scenes.length} for a ${type === "video" ? "vertical reel" : "social post"} about ${categoryLabel}.`,
    `The visual must clearly match this on-screen text: "${scene.onScreenText}".`,
    scene.voiceover ? `It must support this narration: "${scene.voiceover}".` : "",
    previous ? `It should visually progress from the previous idea: "${previous}".` : "",
    next ? `Leave a natural story bridge toward the next idea: "${next}".` : "",
    `Style direction: ${styleLabel}. Use one main subject, a clear foreground, natural depth, strong lighting, detailed real objects, and no empty abstract background.`,
    "No text, no letters, no logo, no watermark, no poster typography, no blank gradient, no plain color card.",
  ]
    .filter(Boolean)
    .join(" ");
}

export default function Studio() {
  const [activeView, setActiveView] = useState("Generate");
  const [category, setCategory] = useState("motivation");
  const [customCategory, setCustomCategory] = useState("");
  const [type, setType] = useState("video");
  const [language, setLanguage] = useState("English");
  const [style, setStyle] = useState("auto");
  const [sceneCount, setSceneCount] = useState(4);
  const [handle, setHandle] = useState(process.env.NEXT_PUBLIC_HANDLE || "");
  const [idea, setIdea] = useState("");

  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState([]);
  const [error, setError] = useState(null);
  const [plan, setPlan] = useState(null);
  const [shots, setShots] = useState([]);
  const [output, setOutput] = useState(null);
  const [renderPct, setRenderPct] = useState(0);
  const [copied, setCopied] = useState("");
  const [meme, setMeme] = useState(emptyMeme);
  const [history, setHistory] = useState([]);
  const [providers, setProviders] = useState([]);
  const [providerKeys, setProviderKeys] = useState(emptyProviderKeys);
  const [settings, setSettings] = useState(defaultSettings);
  const [schedule, setSchedule] = useState([]);
  const [scheduleDraft, setScheduleDraft] = useState({
    date: new Date().toISOString().slice(0, 10),
    type: "video",
    category: "motivation",
  });

  const canvasRef = useRef(null);
  const outputRef = useRef(null);

  const selectedStyle = useMemo(
    () => CREATOR_STYLES.find((item) => item.id === style) || CREATOR_STYLES.at(-1),
    [style]
  );
  const selectedCategory = NICHES.find((item) => item.id === category);
  const categoryLabel = category === "custom" ? customCategory || "Custom" : selectedCategory?.label || "Motivation";
  const isReel = type === "video";
  const isMeme = type === "meme";
  const fullCaption = plan ? `${plan.caption}\n\n${plan.hashtags.join(" ")}` : "";
  const scriptText = plan?.scenes?.map((scene, index) => `${index + 1}. ${scene.voiceover}`).join("\n") || "";
  const canGenerate = category !== "custom" || customCategory.trim().length > 1;
  const studioClass = `studio-shell theme-${settings.appTheme}`;

  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      try {
        setHistory(JSON.parse(saved).slice(0, 24));
      } catch {
        localStorage.removeItem(STORAGE_KEY);
      }
    }
    const savedProviders = localStorage.getItem(PROVIDER_KEY);
    if (savedProviders) {
      try {
        setProviderKeys({ ...emptyProviderKeys, ...JSON.parse(savedProviders) });
      } catch {
        localStorage.removeItem(PROVIDER_KEY);
      }
    }
    const savedSettings = localStorage.getItem(SETTINGS_KEY);
    if (savedSettings) {
      try {
        setSettings({ ...defaultSettings, ...JSON.parse(savedSettings) });
      } catch {
        localStorage.removeItem(SETTINGS_KEY);
      }
    }
    const savedSchedule = localStorage.getItem(SCHEDULE_KEY);
    if (savedSchedule) {
      try {
        setSchedule(JSON.parse(savedSchedule).slice(0, 30));
      } catch {
        localStorage.removeItem(SCHEDULE_KEY);
      }
    }

    fetch("/api/plan")
      .then((res) => res.json())
      .then((json) => setProviders(json.textProviders || []))
      .catch(() => setProviders([]));

    return () => {
      if (outputRef.current) URL.revokeObjectURL(outputRef.current);
    };
  }, []);

  function remember(item) {
    setHistory((prev) => {
      const next = [item, ...prev].slice(0, 24);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  }

  function updateProviderKey(key, value) {
    setProviderKeys((prev) => {
      const next = { ...prev, [key]: value };
      localStorage.setItem(PROVIDER_KEY, JSON.stringify(next));
      return next;
    });
  }

  function updateSetting(key, value) {
    setSettings((prev) => {
      const next = { ...prev, [key]: value };
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
      return next;
    });
  }

  function addSchedule() {
    const item = {
      id: crypto.randomUUID(),
      date: scheduleDraft.date,
      category: scheduleDraft.category,
      type: scheduleDraft.type,
      status: "scheduled",
      createdAt: new Date().toISOString(),
    };
    setSchedule((prev) => {
      const next = [item, ...prev].sort((a, b) => a.date.localeCompare(b.date)).slice(0, 30);
      localStorage.setItem(SCHEDULE_KEY, JSON.stringify(next));
      return next;
    });
  }

  function removeSchedule(id) {
    setSchedule((prev) => {
      const next = prev.filter((item) => item.id !== id);
      localStorage.setItem(SCHEDULE_KEY, JSON.stringify(next));
      return next;
    });
  }

  const push = useCallback((id, label, state = "run") => {
    setLog((prev) => [...prev.filter((item) => item.id !== id), { id, label, state }]);
  }, []);

  const settle = useCallback((id, state) => {
    setLog((prev) => prev.map((item) => (item.id === id ? { ...item, state } : item)));
  }, []);

  function clearOutput() {
    if (outputRef.current) URL.revokeObjectURL(outputRef.current);
    outputRef.current = null;
    setOutput(null);
    setRenderPct(0);
  }

  async function fetchPlan() {
    const res = await fetch("/api/plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        niche: category === "custom" ? customCategory : category,
        format: type,
        tone: selectedStyle.tone,
        language,
        sceneCount: isReel ? sceneCount : 1,
        idea,
        handle,
        textProvider: settings.textProvider,
        providerKeys,
      }),
    });
    const json = await res.json();
    if (!json.ok) throw new Error(json.error || "The writer could not be reached.");
    return json.plan;
  }

  async function fetchShot(prompt, seed) {
    const res = await fetch("/api/image", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt,
        style: selectedStyle.image,
        seed,
        imageProvider: settings.imageProvider,
        providerKeys,
      }),
    });
    const json = await res.json();
    if (!json.ok) throw new Error(json.error || "Image generation failed.");
    return json.dataUrl;
  }

  async function fetchAllShots(scenes) {
    const out = new Array(scenes.length);

    for (let index = 0; index < scenes.length; index++) {
      const scene = scenes[index];
      push(`img-${index}`, `Generating precise scene ${index + 1} of ${scenes.length}`);
      try {
        out[index] = await fetchShot(
          sceneImagePrompt(scene, index, scenes, {
            categoryLabel,
            styleLabel: selectedStyle.label,
            type,
          }),
          100000 + index * 7919 + Math.floor(Math.random() * 5000)
        );
        settle(`img-${index}`, "done");
      } catch (err) {
        settle(`img-${index}`, "fail");
        throw err;
      }
    }
    return out;
  }

  async function composeOutput(workingPlan, images) {
    push("render", isReel ? "Rendering reel in this browser" : "Composing 1080x1350 creative");
    await document.fonts.ready;

    const canvas = canvasRef.current;
    const loaded = await Promise.all(images.map(loadImage));

    if (isReel) {
      canvas.width = W;
      canvas.height = H;
      const { marks, total } = timeline(workingPlan.scenes);
      const state = {
        scenes: workingPlan.scenes,
        images: loaded,
        marks,
        total,
        hook: workingPlan.hook,
        handle,
        theme: THEMES[selectedStyle.theme],
        soundEnabled: settings.soundEnabled,
        soundVolume: Number(settings.soundVolume) || 0.22,
        soundProfile: style === "auto" ? selectedStyle.tone : style,
      };
      const { blob, ext } = await recordReel(canvas, state, setRenderPct);
      const url = URL.createObjectURL(blob);
      outputRef.current = url;
      setOutput({ url, kind: "video", ext });
    } else {
      canvas.width = IMAGE_W;
      canvas.height = IMAGE_H;
      const ctx = canvas.getContext("2d", { alpha: false });
      drawStaticPost(ctx, loaded[0], { plan: workingPlan, type, handle, meme });
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.94));
      const url = URL.createObjectURL(blob);
      outputRef.current = url;
      setOutput({ url, kind: "image", ext: "jpg" });
    }

    settle("render", "done");
  }

  async function produce({ reusePlan = null, reuseShots = null } = {}) {
    if (!canGenerate) {
      setError("Add a custom category before generating.");
      return;
    }

    setBusy(true);
    setError(null);
    setLog([]);
    clearOutput();

    try {
      let workingPlan = reusePlan;
      if (!workingPlan) {
        push("plan", "Writing hook, script, caption and hashtags");
        workingPlan = await fetchPlan();
        settle("plan", "done");
        setPlan(workingPlan);
        setMeme({
          top: workingPlan.hook || "When this finally clicks",
          bottom: workingPlan.title || "You cannot unsee it",
        });
      }

      let images = reuseShots;
      if (!images) {
        images = await fetchAllShots(workingPlan.scenes);
        setShots(images);
      }

      await composeOutput(workingPlan, images);
      remember({
        id: crypto.randomUUID(),
        title: workingPlan.title || workingPlan.hook || "Untitled creative",
        category: categoryLabel,
        type,
        language,
        style,
        createdAt: new Date().toISOString(),
        status: "completed",
      });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function regenerateScene(index) {
    if (!plan?.scenes?.[index]) return;
    setBusy(true);
    setError(null);
    clearOutput();
    try {
      push(`img-${index}`, `Regenerating scene ${index + 1}`);
      const nextShots = [...shots];
      nextShots[index] = await fetchShot(plan.scenes[index].imagePrompt, Date.now() % 1_000_000);
      setShots(nextShots);
      settle(`img-${index}`, "done");
      await composeOutput(plan, nextShots);
    } catch (err) {
      settle(`img-${index}`, "fail");
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function applyEdits() {
    if (!plan || shots.length === 0) return;
    setBusy(true);
    setError(null);
    clearOutput();
    try {
      await composeOutput(plan, shots);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function saveCurrent() {
    if (!plan) return;
    remember({
      id: crypto.randomUUID(),
      title: plan.title || plan.hook || "Untitled creative",
      category: categoryLabel,
      type,
      language,
      style,
      createdAt: new Date().toISOString(),
      status: output ? "saved" : "draft",
    });
    setCopied("saved");
    setTimeout(() => setCopied(""), 1600);
  }

  async function copy(key, text) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      setTimeout(() => setCopied(""), 1600);
    } catch {
      setCopied("");
    }
  }

  function download() {
    if (!output) return;
    const a = document.createElement("a");
    a.href = output.url;
    a.download = `creatorflow-${type}-${Date.now()}.${output.ext}`;
    a.click();
  }

  function updatePlanField(field, value) {
    setPlan((prev) => (prev ? { ...prev, [field]: value } : prev));
  }

  function updateScene(index, field, value) {
    setPlan((prev) => {
      if (!prev) return prev;
      const scenes = prev.scenes.map((scene, sceneIndex) =>
        sceneIndex === index ? { ...scene, [field]: value } : scene
      );
      return { ...prev, scenes };
    });
  }

  return (
    <div className={studioClass}>
      <aside className="sidebar">
        <div className="brand">
          <span>CF</span>
          <div>
            <strong>CreatorFlow AI</strong>
            <small>Reach Optimization Studio</small>
          </div>
        </div>
        <nav>
          {NAV_ITEMS.map((item) => (
            <button key={item} aria-pressed={activeView === item} onClick={() => setActiveView(item)}>
              {item}
            </button>
          ))}
        </nav>
        <div className="sidebar-note">
          <strong>{todayLabel()}</strong>
          <span>Local studio mode. Browser rendering and browser history only.</span>
        </div>
      </aside>

      <main className="workspace">
        <header className="topbar">
          <div>
            <p className="eyebrow">Generate Today</p>
            <h1>{activeView === "Generate" ? "Create reels, images and memes" : activeView}</h1>
          </div>
          <button className="primary-button" disabled={busy || !canGenerate} onClick={() => produce()}>
            {busy ? "Generating" : "Generate"}
          </button>
        </header>

        {activeView === "Dashboard" && <Dashboard history={history} providers={providers} />}
        {activeView === "Generate" && (
          <div className="generate-grid">
            <section className="wizard">
              <ProgressSteps hasPlan={!!plan} hasOutput={!!output} />

              <section className="panel">
                <div className="panel-head">
                  <span>01</span>
                  <h2>Category</h2>
                </div>
                <div className="chip-grid">
                  {NICHES.map((item) => (
                    <button
                      key={item.id}
                      className="choice-chip"
                      aria-pressed={category === item.id}
                      onClick={() => setCategory(item.id)}
                    >
                      <strong>{item.label}</strong>
                      <small>{item.note}</small>
                    </button>
                  ))}
                </div>
                {category === "custom" && (
                  <input
                    className="custom-input"
                    value={customCategory}
                    placeholder="Describe your custom niche"
                    onChange={(event) => setCustomCategory(event.target.value)}
                  />
                )}
              </section>

              <section className="panel">
                <div className="panel-head">
                  <span>02</span>
                  <h2>Type</h2>
                </div>
                <div className="type-grid">
                  {TYPES.map((item) => (
                    <button
                      key={item.id}
                      className="type-card"
                      aria-pressed={type === item.id}
                      onClick={() => setType(item.id)}
                    >
                      <strong>{item.label}</strong>
                      <span>{item.note}</span>
                    </button>
                  ))}
                </div>
              </section>

              <section className="panel">
                <div className="panel-head">
                  <span>03</span>
                  <h2>Language and style</h2>
                </div>
                <div className="form-grid">
                  <label>
                    Language
                    <select value={language} onChange={(event) => setLanguage(event.target.value)}>
                      {LANGUAGES.map((item) => (
                        <option key={item}>{item}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Style
                    <select value={style} onChange={(event) => setStyle(event.target.value)}>
                      {CREATOR_STYLES.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  {isReel && (
                    <label>
                      Reel length
                      <select value={sceneCount} onChange={(event) => setSceneCount(Number(event.target.value))}>
                        {[3, 4, 5, 6, 8, 10, 12].map((count) => (
                          <option key={count} value={count}>
                            {Math.round(count * 3.5)}s, {count} scenes
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  <label>
                    Creator handle
                    <input value={handle} placeholder="@yourhandle" onChange={(event) => setHandle(event.target.value)} />
                  </label>
                </div>
                <label className="wide-label">
                  Angle or topic
                  <textarea
                    value={idea}
                    placeholder="Leave empty for a fresh today-ready angle."
                    onChange={(event) => setIdea(event.target.value)}
                  />
                </label>
              </section>

              <section className="panel action-panel">
                <div>
                  <h2>Reach Optimization</h2>
                  <p>
                    The studio writes for hooks, watch time, saves and comments without promising guaranteed views.
                  </p>
                </div>
                <div className="button-row">
                  <button className="primary-button" disabled={busy || !canGenerate} onClick={() => produce()}>
                    {busy ? "Working" : "Generate"}
                  </button>
                  <button className="secondary-button" disabled={busy || !plan} onClick={() => produce()}>
                    Regenerate All
                  </button>
                  <button className="secondary-button" disabled={busy || !plan} onClick={saveCurrent}>
                    {copied === "saved" ? "Saved" : "Save"}
                  </button>
                </div>

                {log.length > 0 && (
                  <ul className="log">
                    {log.map((item) => (
                      <li key={item.id} data-state={item.state}>
                        <span />
                        {item.label}
                      </li>
                    ))}
                  </ul>
                )}
                {error && (
                  <div className="alert" role="alert">
                    <strong>That run stopped early.</strong>
                    {error}
                  </div>
                )}
              </section>

              {plan && (
                <Editor
                  plan={plan}
                  shots={shots}
                  scriptText={scriptText}
                  meme={meme}
                  isMeme={isMeme}
                  copied={copied}
                  onCopy={copy}
                  onField={updatePlanField}
                  onTags={(value) => updatePlanField("hashtags", cleanTags(value))}
                  onScene={updateScene}
                  onMeme={setMeme}
                  onRegenerateScene={regenerateScene}
                  onApplyEdits={applyEdits}
                  busy={busy}
                />
              )}
            </section>

            <aside className="preview-rail">
              <div className={isReel ? "phone-preview" : "post-preview"}>
                <canvas ref={canvasRef} style={{ display: busy && !output ? "block" : "none" }} />
                {output?.kind === "video" && <video src={output.url} controls loop playsInline />}
                {output?.kind === "image" && <img src={output.url} alt="Generated creative" />}
                {!output && !busy && (
                  <div className="empty-preview">
                    <strong>{isReel ? "1080x1920" : "1080x1350"}</strong>
                    <span>Preview appears here after generation.</span>
                  </div>
                )}
                {busy && isReel && (
                  <div className="render-bar">
                    <i style={{ width: `${Math.round(renderPct * 100)}%` }} />
                  </div>
                )}
              </div>

              <div className="preview-actions">
                <button className="primary-button" disabled={!output} onClick={download}>
                  Download
                </button>
                <button className="secondary-button" disabled={!plan} onClick={() => copy("caption", fullCaption)}>
                  {copied === "caption" ? "Copied" : "Copy"}
                </button>
                <button className="secondary-button" disabled={!plan} onClick={saveCurrent}>
                  {copied === "saved" ? "Saved" : "Save"}
                </button>
              </div>
              <p className="preview-note">
                Reel export stays browser-side. Saved items are kept in this browser for the local studio dashboard.
              </p>
            </aside>
          </div>
        )}
        {activeView === "My Content" && <ContentList history={history} />}
        {activeView === "Calendar" && <Placeholder title="Calendar" body="Daily generation planning is prepared as a local view in this UI-only pass." />}
        {activeView === "Analytics" && <Placeholder title="Analytics" body="Local stats summarize generated and saved content in this browser." />}
        {activeView === "AI Providers" && <Providers providers={providers} />}
        {activeView === "Settings" && (
          <Placeholder title="Settings" body="Handle, language and generation preferences are edited directly in the Generate view." />
        )}
      </main>
    </div>
  );
}

function ProgressSteps({ hasPlan, hasOutput }) {
  const steps = [
    "Generate Today",
    "Category",
    "Type",
    "Language",
    "Style",
    "Generate",
    "Preview",
    "Edit",
    "Download/Save",
  ];
  return (
    <div className="progress-strip">
      {steps.map((step, index) => (
        <span key={step} data-done={index < 5 || (index === 5 && hasPlan) || (index > 5 && hasOutput)}>
          {step}
        </span>
      ))}
    </div>
  );
}

function Editor({
  plan,
  shots,
  scriptText,
  meme,
  isMeme,
  copied,
  onCopy,
  onField,
  onTags,
  onScene,
  onMeme,
  onRegenerateScene,
  onApplyEdits,
  busy,
}) {
  return (
    <section className="panel editor-panel">
      <div className="panel-head">
        <span>04</span>
        <h2>Edit</h2>
      </div>
      <div className="editor-grid">
        <label>
          Title
          <input value={plan.title} onChange={(event) => onField("title", event.target.value)} />
        </label>
        <label>
          Caption
          <textarea value={plan.caption} onChange={(event) => onField("caption", event.target.value)} />
        </label>
        <label>
          Hashtags
          <textarea value={plan.hashtags.join(" ")} onChange={(event) => onTags(event.target.value)} />
        </label>
        <label>
          Script
          <textarea value={plan.script || scriptText} onChange={(event) => onField("script", event.target.value)} />
        </label>
      </div>

      {isMeme && (
        <div className="meme-fields">
          <label>
            Top text
            <input value={meme.top} onChange={(event) => onMeme((prev) => ({ ...prev, top: event.target.value }))} />
          </label>
          <label>
            Bottom text
            <input value={meme.bottom} onChange={(event) => onMeme((prev) => ({ ...prev, bottom: event.target.value }))} />
          </label>
        </div>
      )}

      <div className="button-row">
        <button className="secondary-button" disabled={busy} onClick={onApplyEdits}>
          Edit Preview
        </button>
        <button className="secondary-button" onClick={() => onCopy("title", plan.title)}>
          {copied === "title" ? "Copied" : "Copy Title"}
        </button>
        <button className="secondary-button" onClick={() => onCopy("captionFull", `${plan.caption}\n\n${plan.hashtags.join(" ")}`)}>
          {copied === "captionFull" ? "Copied" : "Copy Caption"}
        </button>
      </div>

      <div className="scene-list">
        {plan.scenes.map((scene, index) => (
          <div className="scene-row" key={index}>
            {shots[index] ? <img src={shots[index]} alt="" /> : <div className="scene-thumb" />}
            <div>
              <input value={scene.onScreenText} onChange={(event) => onScene(index, "onScreenText", event.target.value)} />
              <textarea value={scene.voiceover} onChange={(event) => onScene(index, "voiceover", event.target.value)} />
              <button className="text-button" disabled={busy} onClick={() => onRegenerateScene(index)}>
                Regenerate Scene
              </button>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function Dashboard({ history, providers }) {
  const today = new Date().toDateString();
  const todayCount = history.filter((item) => new Date(item.createdAt).toDateString() === today).length;
  return (
    <div className="view-grid">
      <Metric label="Today" value={todayCount} />
      <Metric label="Saved" value={history.filter((item) => item.status === "saved").length} />
      <Metric label="Text Providers" value={providers.length || "0"} />
      <ContentList history={history.slice(0, 6)} compact />
    </div>
  );
}

function Metric({ label, value }) {
  return (
    <section className="metric-card">
      <span>{label}</span>
      <strong>{value}</strong>
    </section>
  );
}

function ContentList({ history, compact = false }) {
  return (
    <section className={compact ? "panel content-panel wide" : "panel content-panel"}>
      <div className="panel-head">
        <span>{history.length}</span>
        <h2>Recent content</h2>
      </div>
      {history.length === 0 ? (
        <p className="muted">No local content yet. Generate something and press Save.</p>
      ) : (
        <div className="content-list">
          {history.map((item) => (
            <article key={item.id}>
              <div>
                <strong>{item.title}</strong>
                <span>
                  {item.category} / {item.type} / {item.language}
                </span>
              </div>
              <small>{new Date(item.createdAt).toLocaleString()}</small>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function Providers({ providers }) {
  return (
    <section className="panel">
      <div className="panel-head">
        <span>AI</span>
        <h2>Providers</h2>
      </div>
      <div className="provider-grid">
        {["Groq", "Gemini", "OpenRouter", "Cloudflare Workers AI", "Together", "Pollinations"].map((provider) => (
          <div key={provider}>
            <strong>{provider}</strong>
            <span>
              {providers.map((item) => item.toLowerCase()).includes(provider.toLowerCase())
                ? "Configured for text"
                : provider === "Pollinations"
                  ? "Image fallback"
                  : "Configured by environment"}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

function Placeholder({ title, body }) {
  return (
    <section className="panel placeholder-panel">
      <div className="panel-head">
        <span>Local</span>
        <h2>{title}</h2>
      </div>
      <p>{body}</p>
    </section>
  );
}
