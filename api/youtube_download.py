import asyncio
import base64
import json
import os
import re
import shutil
import tempfile
import traceback
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler
from importlib import metadata
from urllib.parse import urlparse

import yt_dlp
from vercel.blob import AsyncBlobClient

MIN_SECONDS = 30
MAX_SECONDS = 30 * 60
LOCAL_POT_PROVIDER_URL = "http://127.0.0.1:4416"
LOOPBACK_HOSTS = ("127.0.0.1", "localhost", "::1")


def response(handler, status, payload):
    body = json.dumps(payload).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Cache-Control", "no-store, max-age=0")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def normalize_url(value):
    raw = str(value or "").strip()
    if not raw:
        return ""
    try:
        from urllib.parse import parse_qs, urlparse
        url = urlparse(raw if raw.startswith("http") else "https://" + raw)
        host = (url.hostname or "").lower().removeprefix("www.")
        video_id = ""
        if host == "youtu.be":
            video_id = url.path.strip("/").split("/")[0]
        elif host in ("youtube.com", "m.youtube.com"):
            if url.path == "/watch":
                video_id = parse_qs(url.query).get("v", [""])[0]
            elif url.path.startswith("/shorts/"):
                parts = url.path.split("/")
                if len(parts) > 2:
                    video_id = parts[2]
            elif url.path.startswith("/embed/"):
                parts = url.path.split("/")
                if len(parts) > 2:
                    video_id = parts[2]
        if len(video_id) == 11 and all(ch.isalnum() or ch in "_-" for ch in video_id):
            return "https://www.youtube.com/watch?v=" + video_id
    except Exception:
        pass
    return ""


async def upload_file(path, title):
    client = AsyncBlobClient()

    async def chunks():
        with open(path, "rb") as stream:
            while True:
                chunk = stream.read(8 * 1024 * 1024)
                if not chunk:
                    break
                yield chunk

    safe = "".join(ch for ch in title if ch.isalnum() or ch in " _-").strip()[:80] or "youtube-video"
    blob = await client.put(
        "creatorflow/youtube/" + safe + ".mp4",
        chunks(),
        access="public",
        content_type="video/mp4",
        add_random_suffix=True,
        multipart=True,
    )
    return blob


def redact(text, *urls):
    text = str(text)
    for url in urls:
        try:
            password = urlparse(url).password
        except Exception:
            password = None
        if password:
            text = text.replace(password, "***")
    return re.sub(r"(https?://)[^/@\s]+@", r"\1***@", text)


def get_pot_provider_url():
    url = os.environ.get("YOUTUBE_POT_PROVIDER_URL", "").strip().rstrip("/")
    if not url:
        if os.environ.get("VERCEL"):
            raise RuntimeError(
                "YOUTUBE_POT_PROVIDER_URL is not set. Deploy the PO-token provider "
                "(see pot-provider/README.md) and add its URL to the Vercel project environment variables."
            )
        return LOCAL_POT_PROVIDER_URL
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise RuntimeError("YOUTUBE_POT_PROVIDER_URL must be an http(s) URL.")
    if parsed.scheme == "http" and parsed.hostname not in LOOPBACK_HOSTS:
        raise RuntimeError("YOUTUBE_POT_PROVIDER_URL must use https:// for a remote provider.")
    return url


def _provider_headers(parsed):
    headers = {"User-Agent": "creatorflow-pot-check"}
    if parsed.username is not None:
        token = base64.b64encode(f"{parsed.username}:{parsed.password or ''}".encode()).decode()
        headers["Authorization"] = "Basic " + token
    return headers


def check_pot_provider(base_url):
    parsed = urlparse(base_url)
    host = parsed.hostname + (":" + str(parsed.port) if parsed.port else "")
    clean = f"{parsed.scheme}://{host}"
    headers = _provider_headers(parsed)
    last = None
    for _ in range(2):
        try:
            request = urllib.request.Request(clean + "/ping", headers=headers)
            with urllib.request.urlopen(request, timeout=8) as res:
                data = json.load(res)
            break
        except urllib.error.HTTPError as exc:
            if exc.code in (401, 403):
                raise RuntimeError(f"PO-token provider at {clean} rejected the credentials (HTTP {exc.code}). Check YOUTUBE_POT_PROVIDER_URL.")
            last = f"HTTP {exc.code}"
        except Exception as exc:
            last = f"{exc.__class__.__name__}: {exc}"
    else:
        raise RuntimeError(f"PO-token provider at {clean} is unreachable ({redact(last, base_url)}). Check that it is running.")
    server_version = str(data.get("version") or "")
    try:
        plugin_version = metadata.version("bgutil-ytdlp-pot-provider")
    except metadata.PackageNotFoundError as exc:
        raise RuntimeError("bgutil-ytdlp-pot-provider is not installed in the yt-dlp environment.") from exc
    if server_version.split(".")[0] != plugin_version.split(".")[0]:
        raise RuntimeError(f"PO-token provider version {server_version or 'unknown'} does not match the yt-dlp plugin {plugin_version}.")
    if server_version != plugin_version:
        print(f"[creatorflow-youtube] warning: provider {server_version} != plugin {plugin_version}")
    return server_version


class PotLogger:
    def __init__(self, base_url):
        self.base_url = base_url
        self.everything = bool(os.environ.get("YOUTUBE_DLP_VERBOSE"))
        self.pot_requested = False
        self.pot_failed = False
    def _emit(self, level, msg):
        msg = redact(msg, self.base_url)
        low = msg.lower()
        related = "po token" in low or "[pot" in low
        if related and "generating" in low:
            self.pot_requested = True
        if related and level in ("warning", "error"):
            self.pot_failed = True
        if self.everything:
            print(f"[yt-dlp:{level}] {msg}")
            return
        if low.startswith("[debug] params:"):
            return
        if level in ("warning", "error") or "generating" in low or "po token providers" in low:
            print(f"[yt-dlp:{level}] {msg}")
    def debug(self, msg): self._emit("debug", msg)
    def info(self, msg): self._emit("info", msg)
    def warning(self, msg, *args, **kwargs): self._emit("warning", msg)
    def error(self, msg): self._emit("error", msg)


def build_ydl_options(workdir, pot_url, pot_logger):
    output = os.path.join(workdir, "%(id)s.%(ext)s")
    options = {
        "outtmpl": output,
        "noplaylist": True,
        "quiet": True,
        "restrictfilenames": True,
        "verbose": True,
        "logger": pot_logger,
        "format": "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/b",
        "merge_output_format": "mp4",
        "ffmpeg_location": os.environ.get("FFMPEG_LOCATION", ""),
        "socket_timeout": 30,
        "retries": 3,
        "fragment_retries": 3,
        "extractor_retries": 3,
        "extractor_args": {
            "youtube": {"player_client": ["mweb", "tv", "web_embedded"]},
            "youtubepot-bgutilhttp": {"base_url": [pot_url]},
        },
    }
    if not options["ffmpeg_location"]:
        try:
            import imageio_ffmpeg
            options["ffmpeg_location"] = imageio_ffmpeg.get_ffmpeg_exe()
        except Exception:
            options.pop("ffmpeg_location", None)
    return options


def download_youtube(url, workdir, pot_url):
    pot_logger = PotLogger(pot_url)
    with yt_dlp.YoutubeDL(build_ydl_options(workdir, pot_url, pot_logger)) as ydl:
        info = ydl.extract_info(url, download=True)
    if pot_logger.pot_requested and not pot_logger.pot_failed:
        print("[creatorflow-youtube] PO token provider used")
    elif pot_logger.pot_requested:
        print("[creatorflow-youtube] PO token provider was called but reported problems")
    candidates = [os.path.join(workdir, n) for n in os.listdir(workdir) if n.lower().endswith(".mp4")]
    if not candidates:
        raise RuntimeError("yt-dlp did not produce an MP4 file. The selected YouTube video may require authentication or a newer extractor.")
    path = max(candidates, key=os.path.getsize)
    duration = float(info.get("duration") or 0)
    if duration < MIN_SECONDS or duration > MAX_SECONDS:
        raise RuntimeError("Source video must be between 30 seconds and 30 minutes.")
    return path, info


async def process(body):
    url = normalize_url(body.get("youtubeUrl"))
    if not url:
        raise ValueError("Paste a valid YouTube URL.")
    if not os.environ.get("BLOB_READ_WRITE_TOKEN") and not os.environ.get("VERCEL_OIDC_TOKEN"):
        raise RuntimeError("Vercel Blob is not configured. Create a Public Blob store and connect it to this project.")
    pot_url = get_pot_provider_url()
    await asyncio.to_thread(check_pot_provider, pot_url)
    workdir = tempfile.mkdtemp(prefix="creatorflow-youtube-")
    try:
        path, info = download_youtube(url, workdir, pot_url)
        blob = await upload_file(path, info.get("title") or "youtube-video")
        return {
            "ok": True, "mediaUrl": blob.url, "downloadUrl": getattr(blob, "download_url", None) or blob.url,
            "title": str(info.get("title") or "YouTube video"), "duration": float(info.get("duration") or 0),
            "width": int(info.get("width") or 0), "height": int(info.get("height") or 0),
            "size": os.path.getsize(path), "provider": "yt-dlp",
        }
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


class handler(BaseHTTPRequestHandler):
    def do_POST(self):
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length > 64 * 1024:
                response(self, 413, {"ok": False, "error": "Request is too large."})
                return
            body = json.loads(self.rfile.read(length) or b"{}")
            result = asyncio.run(process(body))
            response(self, 200, result)
        except ValueError as exc:
            response(self, 400, {"ok": False, "error": str(exc)})
        except Exception as exc:
            print("[creatorflow-youtube]", traceback.format_exc())
            message = redact(exc, os.environ.get("YOUTUBE_POT_PROVIDER_URL", ""))
            if "sign in to confirm" in message.lower():
                message += " The PO-token provider responded, but YouTube still challenged this request; the server's egress IP may be flagged."
            if "BLOB" in message.upper():
                message = "Vercel Blob upload failed. Check BLOB_READ_WRITE_TOKEN and the Blob store connection."
            response(self, 502, {"ok": False, "error": message})
    def do_GET(self):
        response(self, 405, {"ok": False, "error": "Use POST with a YouTube URL."})
