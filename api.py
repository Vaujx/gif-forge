"""
GIF Forge — backend API bridged into the webview's JavaScript context.

Every public method on Api is callable from the frontend as
window.pywebview.api.<method_name>(...) and returns a JSON-serialisable
value (pywebview handles the Promise wiring on the JS side).
"""

import base64
import http.server
import mimetypes
import os
import re
import shutil
import socketserver
import subprocess
import sys
import tempfile
import threading
import urllib.parse
import uuid

import imageio_ffmpeg
import webview

# pywebview 6.0 deprecated the module-level webview.OPEN_DIALOG / SAVE_DIALOG /
# FOLDER_DIALOG constants in favor of a webview.FileDialog enum (whose "open"
# member is named LOAD on some releases and OPEN on others). Resolve whichever
# this install actually has so the app works on both 5.x and 6.x.
if hasattr(webview, "FileDialog"):
    _FD = webview.FileDialog
    DIALOG_OPEN = getattr(_FD, "OPEN", None) or getattr(_FD, "LOAD")
    DIALOG_SAVE = _FD.SAVE
else:
    DIALOG_OPEN = webview.OPEN_DIALOG
    DIALOG_SAVE = webview.SAVE_DIALOG

# --------------------------------------------------------------------------
# Resource / binary resolution (dev run vs. frozen PyInstaller exe)
# --------------------------------------------------------------------------

def resource_path(*parts: str) -> str:
    """Resolve a path that works both in source and inside a PyInstaller exe."""
    base = getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__)))
    return os.path.join(base, *parts)


def _bundled_ffmpeg() -> str | None:
    """Prefer a copy dropped in bin/ by build.py — this is the one PyInstaller
    ships. Falls back to imageio_ffmpeg's own cached binary for dev runs."""
    exe_name = "ffmpeg.exe" if sys.platform == "win32" else "ffmpeg"
    candidate = resource_path("bin", exe_name)
    if os.path.isfile(candidate):
        return candidate
    return None


def get_ffmpeg_path() -> str:
    return _bundled_ffmpeg() or imageio_ffmpeg.get_ffmpeg_exe()


# Hide the console window ffmpeg would otherwise flash open on Windows.
_POPEN_FLAGS = 0
if sys.platform == "win32":
    _POPEN_FLAGS = subprocess.CREATE_NO_WINDOW


def _run(cmd: list[str]) -> str:
    proc = subprocess.run(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        encoding="utf-8",
        errors="replace",
        creationflags=_POPEN_FLAGS,
    )
    if proc.returncode != 0:
        raise RuntimeError(proc.stdout[-2000:])
    return proc.stdout


_DURATION_RE = re.compile(r"Duration:\s*(\d+):(\d+):(\d+\.\d+)")
_RES_RE = re.compile(r"(\d{2,5})x(\d{2,5})")


# --------------------------------------------------------------------------
# Tiny local HTTP server so <video> can stream the source file.
#
# pywebview's Windows renderer (WebView2 / Chromium) blocks file:// access
# to anything outside the directory the HTML page itself lives in, and
# file:// video also doesn't support byte-range seeking reliably. Serving
# the picked video over http://127.0.0.1 sidesteps both problems.
# --------------------------------------------------------------------------

_VIDEO_TOKENS: dict[str, str] = {}
_SERVER_PORT: int | None = None


class _RangeRequestHandler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        qs = urllib.parse.urlparse(self.path).query
        token = urllib.parse.parse_qs(qs).get("token", [None])[0]
        path = _VIDEO_TOKENS.get(token)
        if not path or not os.path.isfile(path):
            self.send_error(404)
            return

        file_size = os.path.getsize(path)
        mime = mimetypes.guess_type(path)[0] or "video/mp4"
        range_header = self.headers.get("Range")

        if range_header:
            start_s, _, end_s = range_header.replace("bytes=", "").partition("-")
            start = int(start_s) if start_s else 0
            end = int(end_s) if end_s else file_size - 1
            end = min(end, file_size - 1)
            length = end - start + 1
            self.send_response(206)
            self.send_header("Content-Range", f"bytes {start}-{end}/{file_size}")
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Content-Length", str(length))
            self.send_header("Content-Type", mime)
            self.end_headers()
            with open(path, "rb") as f:
                f.seek(start)
                remaining = length
                while remaining > 0:
                    chunk = f.read(min(65536, remaining))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    remaining -= len(chunk)
        else:
            self.send_response(200)
            self.send_header("Content-Type", mime)
            self.send_header("Content-Length", str(file_size))
            self.send_header("Accept-Ranges", "bytes")
            self.end_headers()
            with open(path, "rb") as f:
                shutil.copyfileobj(f, self.wfile)

    def log_message(self, format, *args):  # noqa: A002
        pass  # silence per-request console spam


def _start_local_server():
    global _SERVER_PORT
    httpd = socketserver.ThreadingTCPServer(("127.0.0.1", 0), _RangeRequestHandler)
    _SERVER_PORT = httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()


_start_local_server()


class Api:
    def __init__(self):
        self._jobs: dict[str, dict] = {}

    # ---------------------------------------------------------------- files
    def pick_video(self):
        window = webview.windows[0]
        result = window.create_file_dialog(
            DIALOG_OPEN,
            file_types=(
                "Video files (*.mp4;*.mov;*.webm;*.mkv;*.avi)",
                "All files (*.*)",
            ),
        )
        if not result:
            return None
        path = result[0]
        try:
            info = self.probe(path)
        except Exception as exc:  # noqa: BLE001
            return {"path": path, "error": str(exc)[:300]}
        return {"path": path, "info": info}

    def pick_save_path(self, suggested_name: str):
        window = webview.windows[0]
        result = window.create_file_dialog(
            DIALOG_SAVE,
            save_filename=suggested_name or "output.gif",
            file_types=("GIF image (*.gif)",),
        )
        if not result:
            return None
        return result if isinstance(result, str) else result[0]

    # --------------------------------------------------------------- probe
    def probe(self, path: str):
        """Read duration / resolution out of ffmpeg's stderr banner — no
        ffprobe binary required, keeps the bundle to one exe."""
        out = subprocess.run(
            [get_ffmpeg_path(), "-i", path],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            encoding="utf-8",
            errors="replace",
            creationflags=_POPEN_FLAGS,
        ).stdout

        duration = 0.0
        m = _DURATION_RE.search(out)
        if m:
            h, mnt, s = m.groups()
            duration = int(h) * 3600 + int(mnt) * 60 + float(s)

        width, height = 0, 0
        for line in out.splitlines():
            if "Video:" in line:
                rm = _RES_RE.search(line)
                if rm:
                    width, height = int(rm.group(1)), int(rm.group(2))
                break

        return {
            "duration": round(duration, 2),
            "width": width,
            "height": height,
        }

    # ------------------------------------------------------------- preview
    def get_video_url(self, path: str):
        """Hands the frontend a local http:// URL for the given file so
        <video> can stream it (see the server section above for why)."""
        token = uuid.uuid4().hex
        _VIDEO_TOKENS[token] = path
        return f"http://127.0.0.1:{_SERVER_PORT}/video?token={token}"

    # ---------------------------------------------------------------- job
    def start_job(self, params: dict):
        """Kicks off a background conversion, returns a job id immediately.
        Progress/completion is pushed to the frontend via evaluate_js."""
        job_id = uuid.uuid4().hex[:10]
        self._jobs[job_id] = {"cancelled": False}
        threading.Thread(
            target=self._run_job, args=(job_id, params), daemon=True
        ).start()
        return job_id

    def cancel_job(self, job_id: str):
        job = self._jobs.get(job_id)
        if job:
            job["cancelled"] = True
        return True

    def _push(self, event: str, payload: dict):
        window = webview.windows[0]
        import json

        js = (
            "window.__gifForgeEvent && window.__gifForgeEvent("
            f"{json.dumps(payload)}, {json.dumps(event)})"
        )
        try:
            window.evaluate_js(js)
        except Exception:
            pass

    def _run_job(self, job_id: str, p: dict):
        try:
            src = p["path"]
            start = float(p.get("start", 0))
            end = float(p.get("end", start + 2))
            width = p.get("width")  # int or "original"
            fps = int(p.get("fps", 15))
            out_path = p["out_path"]

            duration = max(0.05, end - start)
            ffmpeg = get_ffmpeg_path()

            if width and width != "original":
                scale = f"scale={int(width)}:-1:flags=lanczos"
            else:
                scale = "scale=trunc(iw/2)*2:trunc(ih/2)*2"
            vf = f"fps={fps},{scale}"

            work_dir = os.path.dirname(out_path) or "."
            palette = os.path.join(work_dir, f".gifforge_{job_id}.png")

            self._push("progress", {"job": job_id, "stage": "palette", "pct": 10})
            _run([
                ffmpeg, "-y", "-ss", str(start), "-t", str(duration), "-i", src,
                "-vf", f"{vf},palettegen=stats_mode=diff",
                palette,
            ])

            if self._jobs[job_id]["cancelled"]:
                raise RuntimeError("cancelled")

            self._push("progress", {"job": job_id, "stage": "encode", "pct": 55})
            _run([
                ffmpeg, "-y", "-ss", str(start), "-t", str(duration), "-i", src,
                "-i", palette,
                "-filter_complex", f"{vf}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=3",
                out_path,
            ])

            if os.path.exists(palette):
                os.remove(palette)

            size_kb = round(os.path.getsize(out_path) / 1024, 1)
            self._push("progress", {"job": job_id, "stage": "done", "pct": 100})
            self._push("complete", {"job": job_id, "out_path": out_path, "size_kb": size_kb})
        except Exception as exc:  # noqa: BLE001
            self._push("error", {"job": job_id, "message": str(exc)[:500]})
        finally:
            self._jobs.pop(job_id, None)

    # -------------------------------------------------------- frame grab
    def read_frame_b64(self, path: str, at_seconds: float):
        """Grabs a single frame as base64 JPEG — reserved for a future
        scrub-preview feature (dragging the trim handles shows a thumbnail
        instead of relying on <video> seeking)."""
        ffmpeg = get_ffmpeg_path()
        tmp = os.path.join(tempfile.gettempdir(), f"gifforge_frame_{uuid.uuid4().hex[:6]}.jpg")
        try:
            _run([
                ffmpeg, "-y", "-ss", str(max(0, at_seconds)), "-i", path,
                "-frames:v", "1", "-q:v", "3", tmp,
            ])
            with open(tmp, "rb") as f:
                data = base64.b64encode(f.read()).decode("ascii")
            return f"data:image/jpeg;base64,{data}"
        finally:
            if os.path.exists(tmp):
                os.remove(tmp)

    # ------------------------------------------------------------ reveal
    def reveal_in_folder(self, path: str):
        """Opens the OS file browser with the generated GIF selected/visible."""
        folder = os.path.dirname(path)
        try:
            if sys.platform == "win32":
                subprocess.run(["explorer", "/select,", path])
            elif sys.platform == "darwin":
                subprocess.run(["open", "-R", path])
            else:
                subprocess.run(["xdg-open", folder])
            return True
        except Exception:
            return False