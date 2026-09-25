/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  // Do not force COEP/COOP globally. YouTube's cross-origin iframe does not
  // opt into COEP, so a global "require-corp" header causes Chrome to block
  // the embedded player with "www.youtube.com refused to connect".
  // lib/remux.js already detects crossOriginIsolated and falls back to the
  // single-threaded FFmpeg core when isolation is unavailable.
};

export default nextConfig;
