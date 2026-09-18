/**
 * next.config.mjs — additions for this update.
 *
 * Merge the `headers()` block below into your existing config. It sets
 * Cross-Origin-Opener-Policy and Cross-Origin-Embedder-Policy, which is what
 * makes `self.crossOriginIsolated === true` in the browser — the flag
 * lib/remux.js checks before requesting the multi-threaded ffmpeg core.
 * Without it, everything still works, just single-threaded and slower.
 *
 * Safe to add: this app has no cross-origin iframes, no third-party embeds
 * that need to read this page, and doesn't embed itself in anyone else's
 * iframe. COEP does mean every cross-origin resource the page loads (Google
 * Fonts, the Pollinations/Cloudflare image responses that already come back
 * as data URLs, not live cross-origin <img> tags) must itself opt in via
 * `Cross-Origin-Resource-Policy` or be fetched with `crossorigin="anonymous"`
 * — this app already routes third-party image bytes through its own API
 * routes as data URLs for the canvas-tainting reason documented in
 * lib/imagegen.js, so nothing here should break. Test the whole flow after
 * adding this, particularly the Google Fonts `<link>` tags in app/layout.js.
 */

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          { key: "Cross-Origin-Embedder-Policy", value: "require-corp" },
        ],
      },
    ];
  },
};

export default nextConfig;
