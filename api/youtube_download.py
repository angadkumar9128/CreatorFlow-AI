import asyncio
import json
import os
import shutil
import tempfile
import traceback
from http.server import BaseHTTPRequestHandler

import yt_dlp
from vercel.blob import AsyncBlobClient

MIN_SECONDS = 30
MAX_SECONDS = 30 * 60


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
        from urllib.parse import urlparse, parse_qs
        url = urlparse(raw if raw.startswith("http") else "https://" + raw)
        host = (url.hostname or "").lower().removeprefix("www.")
        video_id = ""
        if host == "youtu.be":
            video_id = url.path.strip("/").split("/")[0]
        elif host in ("youtube.com", "m.youtube.com"):
            if url.path == "/watch":
                video_id = parse_qs(url.query).get("v", [""])[0]
            elif url.path.startswith("/shorts/"):
                video_id = url.path.split("/")[2]
            elif url.path.startswith("/embed/"):
                video_id = url.path.split("/")[2]
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


def download_youtube(url, workdir):
    output = os.path.join(workdir, "%(id)s.%(ext)s")
    options = {
        "outtmpl": output,
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
        "restrictfilenames": True,
        "format": "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/b",
        "merge_output_format": "mp4",
        "ffmpeg_location": os.environ.get("FFMPEG_LOCATION", ""),
        "socket_timeout": 30,
        "retries": 3,
        "fragment_retries": 3,
        "extractor_retries": 3,
    }

    # imageio-ffmpeg supplies an actual ffmpeg binary when present.
    if not options["ffmpeg_location"]:
        try:
            import imageio_ffmpeg
            options["ffmpeg_location"] = imageio_ffmpeg.get_ffmpeg_exe()
        except Exception:
            options.pop("ffmpeg_location", None)

    with yt_dlp.YoutubeDL(options) as ydl:
        info = ydl.extract_info(url, download=True)

    candidates = [
        os.path.join(workdir, name)
        for name in os.listdir(workdir)
        if name.lower().endswith(".mp4")
    ]
    if not candidates:
        raise RuntimeError("yt-dlp did not produce an MP4 file. The selected YouTube video may require a newer extractor, PO Token, or authentication.")
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
        raise RuntimeError("Vercel Blob is not configured. Create a Public Blob store in Vercel Storage and connect it to this project.")

    workdir = tempfile.mkdtemp(prefix="creatorflow-youtube-")
    try:
        path, info = download_youtube(url, workdir)
        blob = await upload_file(path, info.get("title") or "youtube-video")
        return {
            "ok": True,
            "mediaUrl": blob.url,
            "downloadUrl": getattr(blob, "download_url", None) or blob.url,
            "title": str(info.get("title") or "YouTube video"),
            "duration": float(info.get("duration") or 0),
            "width": int(info.get("width") or 0),
            "height": int(info.get("height") or 0),
            "size": os.path.getsize(path),
            "provider": "yt-dlp",
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
            message = str(exc)
            if "BLOB" in message.upper():
                message = "YouTube download completed, but Vercel Blob storage is not configured. Create a Public Blob store and reconnect it to this project."
            response(self, 502, {"ok": False, "error": message})

    def do_GET(self):
        response(self, 405, {"ok": False, "error": "Use POST with a YouTube URL."})
