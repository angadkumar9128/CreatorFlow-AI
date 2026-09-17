export const NICHES = [
  { id: "motivation", label: "Motivation", note: "discipline, mindset, comeback stories" },
  { id: "technology", label: "Technology", note: "AI, gadgets, coding, future tech" },
  { id: "ai", label: "AI", note: "tools, prompts, workflows, automation" },
  { id: "agriculture", label: "Agriculture", note: "farming tips, agri-business, rural life" },
  { id: "fashion", label: "Fashion", note: "outfits, styling, seasonal trends" },
  { id: "education", label: "Education", note: "study hacks, skills, exam prep" },
  { id: "business", label: "Business", note: "startups, marketing, entrepreneurship" },
  { id: "finance", label: "Finance", note: "saving, investing, side income" },
  { id: "fitness", label: "Fitness", note: "training, nutrition, habit building" },
  { id: "travel", label: "Travel", note: "destinations, budget trips, hidden spots" },
  { id: "food", label: "Food", note: "recipes, street food, food science" },
  { id: "facts", label: "Facts", note: "history, science, surprising truths" },
  { id: "programming", label: "Programming", note: "coding, debugging, developer habits" },
  { id: "memes", label: "Memes", note: "relatable jokes and culture moments" },
  { id: "quotes", label: "Quotes", note: "short lines, wisdom, punchy reminders" },
  { id: "productivity", label: "Productivity", note: "systems, focus, time management" },
  { id: "gaming", label: "Gaming", note: "game culture, tips, reactions" },
  { id: "entertainment", label: "Entertainment", note: "movies, creators, pop culture" },
  { id: "custom", label: "Custom", note: "bring your own content lane" },
];

export const TONES = [
  { id: "punchy", label: "Punchy" },
  { id: "calm", label: "Calm and cinematic" },
  { id: "funny", label: "Funny" },
  { id: "authority", label: "Expert authority" },
];

const SYSTEM = `You are a short-form video strategist who has grown Instagram Reels and Facebook Reels accounts past a million followers. You understand that the first 1.5 seconds decide everything, that watch-time and shares matter far more than likes, and that a caption's opening line is what stops the scroll in the feed.

Rules you never break:
- The hook is a spoken/on-screen line of at most 9 words. It creates an open loop, contradicts an assumption, or promises a specific payoff. Never start with "In this video" or "Did you know".
- On-screen text per scene is at most 11 words. It is readable at arm's length on a phone with the sound off.
- Every scene's image prompt is a concrete photographic or illustrative description: subject, setting, lighting, lens, mood, colour palette. Vertical composition. Never include text, letters, logos or watermarks in the image prompt, because image models render text badly.
- Hashtags mix three sizes: 3 broad (millions of posts), 6 mid-size (100k–2M), 6 niche (under 100k). No banned or spammy tags. No "#followforfollow", "#like4like", "#viral", "#explorepage".
- The caption's first line must work as a standalone hook, because Instagram truncates the rest.

Reply with a single JSON object and nothing else.`;

export function buildSystem() {
  return SYSTEM;
}

export function buildUser({ niche, nicheNote, format, tone, language, sceneCount, idea, handle }) {
  const isStill = format === "image" || format === "meme";
  const scenes = isStill ? 1 : sceneCount;
  const formatLabel =
    format === "meme"
      ? "single-frame meme image with a visual concept that supports editable top and bottom meme text"
      : format === "image"
        ? "single-frame 4:5 Instagram/Facebook image"
        : `${scenes}-scene vertical Reel`;

  return `Create one ${formatLabel} for the "${niche}" niche (${nicheNote}).

Tone: ${tone}.
Language for all viewer-facing text: ${language}. Keep hashtags in English.
Creator handle: ${handle || "not specified"}.
${idea ? `The creator's own angle for today, which you must build on: "${idea}"` : "Pick a fresh angle that has not been done to death."}

Return JSON with exactly this shape:

{
  "concept": "one sentence describing the idea, for the creator not the viewer",
  "hook": "the opening line, max 9 words",
  "title": "a title for the post, max 60 characters",
  "description": "one short sentence describing the content",
  "CTA": "one clear call to action",
  "script": "the full narration script as plain text",
  "caption": "3 to 5 short lines. First line is a standalone hook. Include one question that invites a reply. End with a clear call to action. No hashtags here.",
  "hashtags": ["20 to 22 tags, each starting with #, ordered broad first then mid then niche"],
  "scenes": [
    {
      "onScreenText": "max 11 words",
      "voiceover": "one or two sentences to read aloud, matching the on-screen text",
      "imagePrompt": "detailed vertical image description, no text in image",
      "seconds": 3.5
    }
  ],
  "audioIdea": "what kind of trending audio to add in the Instagram app, described in one line",
  "bestPostTime": "a suggested posting window in IST with a one-line reason",
  "thumbnailPrompt": "vertical cover image description that would make someone stop scrolling, no text in image"
}

There must be exactly ${scenes} item${scenes === 1 ? "" : "s"} in "scenes". Scene durations should add up to roughly ${isStill ? 4 : scenes * 3.5} seconds.`;
}

/** Guard against a model returning something almost-right. */
export function normalisePlan(plan, { format, sceneCount }) {
  const want = format === "image" || format === "meme" ? 1 : sceneCount;

  const scenes = (Array.isArray(plan.scenes) ? plan.scenes : [])
    .slice(0, want)
    .map((s) => ({
      onScreenText: String(s.onScreenText || s.text || "").slice(0, 120),
      voiceover: String(s.voiceover || "").slice(0, 400),
      imagePrompt: String(s.imagePrompt || plan.thumbnailPrompt || "cinematic vertical photograph"),
      seconds: Math.min(6, Math.max(2, Number(s.seconds) || 3.5)),
    }));

  while (scenes.length < want) {
    scenes.push({
      onScreenText: plan.hook || "",
      voiceover: "",
      imagePrompt: plan.thumbnailPrompt || "cinematic vertical photograph",
      seconds: 3.5,
    });
  }

  const hashtags = (Array.isArray(plan.hashtags) ? plan.hashtags : [])
    .map((t) => String(t).trim())
    .map((t) => (t.startsWith("#") ? t : `#${t}`))
    .filter((t) => t.length > 2)
    .slice(0, 22);

  return {
    concept: String(plan.concept || ""),
    hook: String(plan.hook || ""),
    title: String(plan.title || "").slice(0, 100),
    description: String(plan.description || plan.concept || ""),
    CTA: String(plan.CTA || plan.cta || ""),
    script: String(plan.script || ""),
    caption: String(plan.caption || ""),
    hashtags,
    scenes,
    audioIdea: String(plan.audioIdea || ""),
    bestPostTime: String(plan.bestPostTime || ""),
    thumbnailPrompt: String(plan.thumbnailPrompt || ""),
  };
}
