#!/usr/bin/env python3
"""Native messaging host for the Video Download Helper Chrome extension.

Chrome starts one copy of this script per connection. Messages are JSON with a
4-byte native-endian length prefix on stdin/stdout.

Requests:  {"cmd": "ping"}
           {"cmd": "download", "id", "url", "referer", "quality", "cookies", "title", "named"}
           {"cmd": "cancel", "id"}
           {"cmd": "reveal", "path"}        show a saved file in Finder or Explorer
           {"cmd": "update"}                download the latest release over the installed copy
Replies:   {"type": "pong", "ytdlp", "ffmpeg", "version", "installed"}
           {"type": "updated", "version"}
           {"type": "progress", "id", "percent", "speed", "eta"}
           {"type": "done", "id", "path", "existed"}
           {"type": "error", "id", "message"}
"""

import json
import os
import re
import shutil
import struct
import subprocess
import sys
import tarfile
import tempfile
import threading
import urllib.request
from pathlib import Path
from urllib.parse import urlparse

OUT_DIR = Path.home() / "Downloads" / "VideoHelper"
ROOT = Path(__file__).resolve().parent.parent
INSTALL_DIR = Path.home() / ".video-download-helper"
MAX_UPDATE_BYTES = 50 * 1024 * 1024
MAX_MESSAGE = 1024 * 1024
FORMATS = {
    "best": ["-f", "bv*+ba/b"],
    "1080": ["-f", "bv*[height<=1080]+ba/b[height<=1080]/b"],
    "720": ["-f", "bv*[height<=720]+ba/b[height<=720]/b"],
    "audio": ["-f", "ba[ext=m4a]/ba/b", "-x", "--audio-format", "m4a"],
}

IS_WINDOWS = sys.platform == "win32"
# Keep helper tools from flashing a console window on Windows.
NOWINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0) if IS_WINDOWS else 0

# The browser starts us with a bare PATH, so add the usual places for yt-dlp and ffmpeg.
if IS_WINDOWS:
    _extra = [
        str(Path.home() / ".local" / "bin"),
        os.path.join(os.environ.get("LOCALAPPDATA", ""), "Microsoft", "WinGet", "Links"),
        os.path.join(os.environ.get("ProgramData", r"C:\ProgramData"), "chocolatey", "bin"),
        os.path.join(os.environ.get("USERPROFILE", ""), "scoop", "shims"),
    ]
else:
    _extra = [str(Path.home() / ".local" / "bin"), "/opt/homebrew/bin", "/usr/local/bin"]
os.environ["PATH"] = os.pathsep.join(_extra + [os.environ.get("PATH", "")])

_write_lock = threading.Lock()


def dbg(*parts):
    """Debug lines go to stderr (browsers ignore it). Turn on with VDH_DEBUG=1."""
    if os.environ.get("VDH_DEBUG"):
        print("[host]", *parts, file=sys.stderr, flush=True)


def send(msg):
    data = json.dumps(msg).encode("utf-8")
    with _write_lock:
        sys.stdout.buffer.write(struct.pack("=I", len(data)))
        sys.stdout.buffer.write(data)
        sys.stdout.buffer.flush()


def read_message():
    raw = sys.stdin.buffer.read(4)
    if len(raw) < 4:
        return None
    (length,) = struct.unpack("=I", raw)
    if length > MAX_MESSAGE:
        raise ValueError("message too large")
    return json.loads(sys.stdin.buffer.read(length).decode("utf-8"))


def is_http(url):
    try:
        return urlparse(url).scheme in ("http", "https") and bool(urlparse(url).netloc)
    except Exception:
        return False


def tool_version(cmd):
    exe = shutil.which(cmd)
    if not exe:
        return None
    try:
        out = subprocess.run([exe, "--version" if cmd == "yt-dlp" else "-version"], capture_output=True, text=True, timeout=10, creationflags=NOWINDOW).stdout
        return out.splitlines()[0].strip() if out else "unknown"
    except Exception:
        return None


def safe_name(title):
    s = re.sub(r'[\\/:*?"<>|\x00-\x1f]', " ", title or "")
    s = re.sub(r"\s+", " ", s).strip().lstrip(".")
    return s[:100].strip()


def unique_base(title):
    """A file name stem from the page title that does not collide with anything already saved."""
    base = safe_name(title)
    if not base:
        return None
    stem, n = base, 1
    while any(OUT_DIR.glob(glob_escape(stem) + ".*")):
        n += 1
        stem = f"{base} ({n})"
    return stem


def glob_escape(text):
    return re.sub(r"([\[\]*?])", r"[\1]", text)


def output_template(req):
    # Stream links (not page links) carry no useful title of their own, so name them after the page.
    if req.get("named"):
        stem = unique_base(req.get("title", ""))
        if stem:
            return str(OUT_DIR / (stem.replace("%", "%%") + ".%(ext)s"))
    return str(OUT_DIR / "%(title).150B [%(id)s].%(ext)s")


def build_command(req, path_file):
    url = req.get("url", "")
    if not is_http(url):
        raise ValueError("Only http and https addresses are allowed.")
    quality = req.get("quality", "best")
    if quality not in FORMATS:
        raise ValueError("Unknown quality.")
    ytdlp = shutil.which("yt-dlp")
    if not ytdlp:
        raise ValueError("yt-dlp is not installed (brew install yt-dlp).")

    cmd = [
        ytdlp,
        "--newline",
        "--no-colors",
        "--no-playlist",
        "--no-warnings",
        "--concurrent-fragments", "4",
        "--progress-template", "download:PROGRESS|%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s",
        "--print-to-file", "after_move:filepath", path_file,
        "-o", output_template(req),
        "--merge-output-format", "mp4",
        *FORMATS[quality],
    ]
    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg:
        cmd += ["--ffmpeg-location", ffmpeg]
    referer = req.get("referer", "")
    if referer and is_http(referer):
        cmd += ["--add-header", f"Referer:{referer}"]
    if req.get("cookies"):
        cmd += ["--cookies-from-browser", "chrome"]
    cmd += ["--", url]
    return cmd


class Download:
    def __init__(self, req):
        self.id = req.get("id")
        self.req = req
        self.proc = None
        self.canceled = False

    def run(self):
        OUT_DIR.mkdir(parents=True, exist_ok=True)
        fd, path_file = tempfile.mkstemp(prefix="vdh-", suffix=".txt")
        os.close(fd)
        last_error = ""
        existed = False
        try:
            cmd = build_command(self.req, path_file)
            dbg("running", cmd)
            self.proc = subprocess.Popen(
                cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace",
                bufsize=1, creationflags=NOWINDOW,
            )
            for line in self.proc.stdout:
                line = line.strip()
                dbg("yt-dlp:", line[:200])
                if line.startswith("PROGRESS|"):
                    _, pct, speed, eta = (line.split("|") + ["", "", ""])[:4]
                    m = re.search(r"([\d.]+)", pct)
                    send({
                        "type": "progress", "id": self.id,
                        "percent": int(float(m.group(1))) if m else 0,
                        "speed": speed.strip() if speed.strip() not in ("NA", "Unknown B/s") else "",
                        "eta": eta.strip() if eta.strip() not in ("NA", "Unknown") else "",
                    })
                elif line.startswith("ERROR"):
                    last_error = line
                elif "has already been downloaded" in line:
                    existed = True
            code = self.proc.wait()
            dbg("yt-dlp exited", code)
            if self.canceled:
                return
            out_path = ""
            try:
                lines = [l for l in Path(path_file).read_text(encoding="utf-8", errors="replace").splitlines() if l.strip()]
                out_path = lines[-1] if lines else ""
            except OSError:
                pass
            if code == 0 and out_path and Path(out_path).exists():
                send({"type": "done", "id": self.id, "path": out_path, "existed": existed})
            else:
                send({"type": "error", "id": self.id, "message": (last_error or f"yt-dlp stopped with code {code}")[:300]})
        except Exception as e:  # noqa: BLE001
            send({"type": "error", "id": self.id, "message": str(e)[:300]})
        finally:
            try:
                os.unlink(path_file)
            except OSError:
                pass

    def cancel(self):
        self.canceled = True
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()


def installed_version():
    try:
        return json.loads((ROOT / "version.json").read_text())["version"]
    except (OSError, ValueError, KeyError):
        return None


def is_installed_copy():
    """True only when running from the one-line-installer location, never from a development checkout."""
    try:
        return ROOT.resolve() == INSTALL_DIR.resolve()
    except OSError:
        return False


def do_update():
    """Replaces extension/ and host/ with the latest published copy. The browser extension then reloads itself."""
    if not is_installed_copy():
        send({"type": "error", "message": "This is a development copy, not the installed one. Update it with git pull."})
        return
    try:
        cfg = json.loads((ROOT / "extension" / "repo.json").read_text())
        repo, branch = cfg["repo"], cfg.get("branch", "main")
        if not re.fullmatch(r"[\w.-]+/[\w.-]+", repo) or not re.fullmatch(r"[\w./-]+", branch):
            raise ValueError("bad repository settings")
        url = os.environ.get("VDH_UPDATE_URL") or f"https://codeload.github.com/{repo}/tar.gz/refs/heads/{branch}"
        if not (url.startswith("https://") or url.startswith("file://")):
            raise ValueError("update address must be https")

        work = Path(tempfile.mkdtemp(prefix="vdh-update-"))
        try:
            archive = work / "src.tar.gz"
            with urllib.request.urlopen(url, timeout=60) as resp, open(archive, "wb") as out:
                total = 0
                while True:
                    chunk = resp.read(65536)
                    if not chunk:
                        break
                    total += len(chunk)
                    if total > MAX_UPDATE_BYTES:
                        raise ValueError("download is unexpectedly large")
                    out.write(chunk)
            extracted = work / "x"
            extracted.mkdir()
            with tarfile.open(archive) as tar:
                tar.extractall(extracted, filter="data")
            tops = [d for d in extracted.iterdir() if d.is_dir()]
            if len(tops) != 1:
                raise ValueError("unexpected archive layout")
            src = tops[0]
            for needed in ("extension/manifest.json", "host/video_helper_host.py", "host/install.sh", "version.json", "extension-id.txt"):
                if not (src / needed).exists():
                    raise ValueError(f"download is missing {needed}")
            new_version = json.loads((src / "version.json").read_text())["version"]

            backups = []
            try:
                for name in ("extension", "host"):
                    old = ROOT / name
                    bak = ROOT / f".old-{name}"
                    shutil.rmtree(bak, ignore_errors=True)
                    old.rename(bak)
                    backups.append((old, bak))
                    shutil.copytree(src / name, old)
                for f in ("version.json", "extension-id.txt"):
                    shutil.copy2(src / f, ROOT / f)
                if IS_WINDOWS:
                    refresh = ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(ROOT / "host" / "install.ps1"), "-Refresh", "-Python", sys.executable]
                else:
                    refresh = ["bash", str(ROOT / "host" / "install.sh"), "--refresh"]
                subprocess.run(refresh, check=True, capture_output=True, timeout=90, creationflags=NOWINDOW)
            except Exception:
                for old, bak in backups:  # put the previous copy back
                    shutil.rmtree(old, ignore_errors=True)
                    bak.rename(old)
                raise
            for _, bak in backups:
                shutil.rmtree(bak, ignore_errors=True)
        finally:
            shutil.rmtree(work, ignore_errors=True)
        send({"type": "updated", "version": new_version})
    except Exception as e:  # noqa: BLE001
        send({"type": "error", "message": f"Update failed: {str(e)[:200]}"})


def reveal(path):
    try:
        target = Path(path).resolve()
        target.relative_to(OUT_DIR.resolve())
    except (ValueError, OSError):
        send({"type": "error", "message": "That file is outside the VideoHelper folder."})
        return
    if not target.exists():
        send({"type": "error", "message": "That file was moved or deleted."})
        return
    if IS_WINDOWS:
        subprocess.run(["explorer.exe", f"/select,{target}"], check=False, creationflags=NOWINDOW)  # exits 1 even on success
    else:
        subprocess.run(["open", "-R", str(target)], check=False)
    send({"type": "revealed"})


def main():
    current = None
    while True:
        try:
            msg = read_message()
        except Exception as e:  # noqa: BLE001
            send({"type": "error", "message": f"Bad message: {e}"})
            break
        if msg is None:  # Chrome closed the connection
            if current:
                current.cancel()
            break
        cmd = msg.get("cmd")
        if cmd == "ping":
            send({"type": "pong", "ytdlp": tool_version("yt-dlp"), "ffmpeg": bool(shutil.which("ffmpeg")), "version": installed_version(), "installed": is_installed_copy()})
            # a ping connection is short lived; keep looping until Chrome disconnects
        elif cmd == "download" and current is None:
            current = Download(msg)
            threading.Thread(target=current.run, daemon=True).start()
        elif cmd == "cancel" and current:
            current.cancel()
        elif cmd == "reveal":
            reveal(msg.get("path", ""))
        elif cmd == "update":
            do_update()
    # let a finished download thread flush its last message
    sys.stdout.flush()


if __name__ == "__main__":
    main()
