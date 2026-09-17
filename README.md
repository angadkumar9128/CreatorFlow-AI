# Reel Desk

Pick a niche, pick a format, get a finished 9:16 post plus the title, caption and hashtag set that goes under it. Runs entirely on free AI tiers and deploys to Vercel.

---

## How it actually works

Three stages, and it matters that you know which is which:

| Stage | Where it runs | What it costs |
|---|---|---|
| Hook, script, title, caption, hashtags | A free LLM (Groq / Gemini / OpenRouter / Cerebras) | Free tier |
| One image per scene | Cloudflare Workers AI → Together → Pollinations | Free tier |
| Turning those into a video | **Your browser**, via Canvas + MediaRecorder | Nothing, ever |

That last row is the important one. **There is no free text-to-video API.** Veo and Sora have no free tier; Kling and Hailuo charge roughly $0.08–0.10 per second. Every "free AI video generator" you'll find is a web UI with daily tokens, not something you can call from a server.

So this app does what faceless-content accounts actually do: AI writes and paints, then the browser animates. Ken Burns push on each still, crossfades between scenes, animated captions, your handle burned in, safe zones respected so Instagram's own UI never covers your text. The output is a real video file with no watermark.

---

## Setup

```bash
npm install
cp .env.example .env.local
```

Open `.env.local` and add **one** text key — Groq is the easiest:

1. Go to https://console.groq.com/keys, sign in with Google, create a key. No credit card.
2. Paste it as `GROQ_API_KEY`.

```bash
npm run dev
```

That's enough to run. Images will come from Pollinations, which needs no account.

### Making the images better

Pollinations is fine for testing but slow and rate-limited when busy. For real use, add Cloudflare Workers AI — it's the strongest free image tier available:

1. Create a free Cloudflare account, open the dashboard, go to **AI → Workers AI**.
2. Copy your **Account ID** from the URL or the sidebar.
3. Create an API token with the **Workers AI** template.
4. Set `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`.

That gives you 10,000 neurons a day, around 230 FLUX images, resetting daily forever. A 4-scene reel uses 4.

---

## Deploying to Vercel

```bash
git init && git add -A && git commit -m "Reel Desk"
gh repo create reel-desk --private --source=. --push
```

Then on vercel.com: **Add New → Project**, import the repo, and before you click Deploy, paste the same variables from `.env.local` into **Environment Variables**. Framework detection and build settings need no changes.

The two API routes already declare `maxDuration = 60`, which they need because free image endpoints are sometimes slow.

---

## Free tier limits, honestly

- **Groq**: 30 requests/minute. `llama-3.1-8b-instant` allows 14,400 requests/day; the 70B model is capped at 1,000/day. One post = one request. You will not hit this.
- **Cloudflare**: ~230 images/day. At 4 scenes a post, that's about 55 posts a day.
- **Pollinations**: no published limit, but it queues under load and can time out. It's the fallback, not the plan.
- **Free model catalogues churn.** Cerebras deleted most of its free models overnight in May 2026. That's why `lib/llm.js` tries several model ids per provider and several providers in turn — if one id dies, the app keeps working. If everything dies at once, update the `models` arrays.

---

## Things worth knowing

**Audio.** The app deliberately does not bake music in. Instagram only counts a track as trending if you select it from its own audio library — a track baked into your file is invisible to that system, and you'd be risking a copyright claim on top. Upload silent, add audio in the app. The generated posting notes tell you what kind of track to look for.

**MP4 vs WebM.** Chrome and Edge record MP4 directly. Safari and Firefox may give you WebM. Instagram accepts both, but if you want MP4 everywhere, use a Chromium browser or run the WebM through any converter.

**Rendering is real-time.** A 14-second reel takes 14 seconds to record, because MediaRecorder captures the canvas as it plays. This is normal, not a bug.

**Faces and hands.** Fast image models are weak at both. The prompt template leans toward environments, objects and wide shots for a reason. If you need people, expect to regenerate visuals a few times — that's what the "New visuals, same words" button is for.

**Auto-posting.** Not included, and think carefully before adding it. Instagram's Content Publishing API needs a Business account linked to a Facebook Page, an app review, and your media hosted at a public URL. It's free but it is a week of work, and accounts that post fully automated content at volume get reach-limited. Reviewing each post before it goes out is genuinely better for the metric you care about.

---

## Files

```
app/api/plan/route.js    writes the script, caption and hashtags
app/api/image/route.js   generates one scene image
lib/llm.js               provider failover for text
lib/imagegen.js          provider failover for images
lib/prompt.js            the prompt that decides your content quality
lib/render.js            canvas animation + MediaRecorder export
components/Studio.js     the question flow and results
```

`lib/prompt.js` is the file to edit. Everything else is plumbing; that file is the strategy.
