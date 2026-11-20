#!/usr/bin/env python3
"""Native messaging host for the Video Download Helper Chrome extension.

Chrome starts one copy of this script per connection. Messages are JSON with a
4-byte native-endian length prefix on stdin/stdout.

Requests:  {"cmd": "ping"}
           {"cmd": "download", "id", "url", "referer", "quality", "cookies", "title", "named", "subs": {"mode", "langs"}}
           {"cmd": "merge_tracks", "id", "video_url", "audio_url", "sizes", "referer", "title"}
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

OUT_DIR = Path(os.environ.get("VDH_OUT_DIR") or Path.home() / "Downloads" / "VideoHelper")  # env override is for tests
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
        log = os.environ.get("VDH_DEBUG_LOG")  # browsers hide a helper's stderr, so a file is easier to read
        if log:
            with open(log, "a", encoding="utf-8") as f:
                f.write(" ".join(str(p) for p in parts) + "\n")


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


def find_tool(name):
    """Where the installer found the tool (tools.json), else wherever this process can see it.
    The browser's own PATH can be older than the installer's, so the remembered path wins."""
    forced = os.environ.get("VDH_TOOL_" + name.upper().replace("-", "_"))  # test hook
    if forced:
        return forced
    try:
        remembered = json.loads((ROOT / "tools.json").read_text(encoding="utf-8")).get(name)
        if remembered and Path(remembered).exists():
            return remembered
    except (OSError, ValueError):
        pass
    return shutil.which(name)


def tool_version(cmd):
    exe = find_tool(cmd)
    if not exe:
        return None
    try:
        # The first run of a freshly installed yt-dlp.exe can take a while (unpacking, virus scan).
        out = subprocess.run([exe, "--version" if cmd == "yt-dlp" else "-version"], capture_output=True, text=True, timeout=45, creationflags=NOWINDOW, stdin=subprocess.DEVNULL).stdout
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


SUB_MODES = {"off", "file", "embed", "only"}
COOKIE_ERROR = re.compile(r"cookie (database|file)|cookies-from-browser|decrypt", re.IGNORECASE)
SUB_LINE = re.compile(r"Writing video (?:subtitles|automatic captions|auto\w* captions?) to: (.+)$", re.IGNORECASE)


def sub_args(req):
    subs = req.get("subs") or {}
    mode = subs.get("mode", "off")
    if mode not in SUB_MODES:
        raise ValueError("Unknown subtitle option.")
    if mode == "off":
        return []
    langs = subs.get("langs") or "en"
    if not re.fullmatch(r"[A-Za-z0-9,.*_-]{1,60}", langs):
        raise ValueError("Subtitle languages look wrong. Use codes like en,vi,th.")
    args = ["--write-subs", "--write-auto-subs", "--sub-langs", langs]
    if mode == "file":
        args += ["--convert-subs", "srt"]
    elif mode == "embed":
        args += ["--embed-subs"]
    else:  # only
        args += ["--skip-download", "--convert-subs", "srt"]
    return args


def js_runtime_args():
    """YouTube needs a JavaScript runtime for yt-dlp to solve its signature puzzle. Prefer deno, then node."""
    for name in ("deno", "node"):
        exe = find_tool(name)
        if exe:
            return ["--js-runtimes", f"{name}:{exe}"]
    return []


def build_command(req, path_file, cookies=False, js=True):
    url = req.get("url", "")
    if not is_http(url):
        raise ValueError("Only http and https addresses are allowed.")
    quality = req.get("quality", "best")
    if quality not in FORMATS:
        raise ValueError("Unknown quality.")
    ytdlp = find_tool("yt-dlp")
    if not ytdlp:
        raise ValueError("yt-dlp is not installed. Run the install command again.")

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
        *sub_args(req),
    ]
    ffmpeg = find_tool("ffmpeg")
    if ffmpeg:
        cmd += ["--ffmpeg-location", ffmpeg]
    if js:
        cmd += js_runtime_args()
    referer = req.get("referer", "")
    if referer and is_http(referer):
        cmd += ["--add-header", f"Referer:{referer}"]
    if cookies:
        cmd += ["--cookies-from-browser", "chrome"]
    cmd += ["--", url]
    return cmd


class Download:
    def __init__(self, req):
        self.id = req.get("id")
        self.req = req
        self.proc = None
        self.canceled = False

    def _attempt(self, cookies, js):
        """One yt-dlp run. Returns its exit code, saved file, subtitle files and last error line."""
        fd, path_file = tempfile.mkstemp(prefix="vdh-", suffix=".txt")
        os.close(fd)
        res = {"code": -1, "path": "", "subs": [], "error": "", "existed": False}
        try:
            cmd = build_command(self.req, path_file, cookies=cookies, js=js)
            dbg("running", cmd)
            # stdin=DEVNULL is essential on Windows: a child that inherits our stdin pipe blocks on it
            # while the main thread is waiting for the browser's next message, and yt-dlp never starts.
            self.proc = subprocess.Popen(
                cmd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace",
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
                    res["error"] = line
                elif "has already been downloaded" in line:
                    res["existed"] = True
                else:
                    sub = SUB_LINE.search(line)
                    if sub:
                        res["subs"].append(sub.group(1).strip())
                    elif line.startswith("[") and not line.startswith("[download]"):
                        # Extraction can take a while on big sites, so show what yt-dlp is doing.
                        send({"type": "progress", "id": self.id, "percent": None, "note": line[:90]})
            res["code"] = self.proc.wait()
            dbg("yt-dlp exited", res["code"])
            try:
                lines = [l for l in Path(path_file).read_text(encoding="utf-8", errors="replace").splitlines() if l.strip()]
                res["path"] = lines[-1] if lines else ""
            except OSError:
                pass
        finally:
            try:
                os.unlink(path_file)
            except OSError:
                pass
        return res

    @staticmethod
    def _final_sub_files(paths):
        """yt-dlp converts .vtt to .srt after writing, so report whichever file really exists."""
        out = []
        for p in paths:
            base = p.rsplit(".", 1)[0] if "." in p else p
            for cand in (base + ".srt", p):
                if Path(cand).exists():
                    out.append(cand)
                    break
        return list(dict.fromkeys(out))

    def run(self):
        OUT_DIR.mkdir(parents=True, exist_ok=True)
        notes = []
        try:
            cookies = bool(self.req.get("cookies"))
            res = self._attempt(cookies, True)
            if res["code"] != 0 and not self.canceled and "js-runtimes" in res["error"] and "no such option" in res["error"].lower():
                res = self._attempt(cookies, False)  # an older yt-dlp without --js-runtimes
            if res["code"] != 0 and not self.canceled and cookies and COOKIE_ERROR.search(res["error"]):
                # Chrome keeps its cookie file locked (and newer Chrome encrypts it) while it is running.
                send({"type": "progress", "id": self.id, "percent": None, "note": "Chrome has its cookies locked, continuing without your login"})
                notes.append("without your Chrome login")
                res = self._attempt(False, True)
            if self.canceled:
                return
            subs = self._final_sub_files(res["subs"])
            mode = (self.req.get("subs") or {}).get("mode", "off")
            if mode == "only":
                if res["code"] == 0 and subs:
                    send({"type": "done", "id": self.id, "path": subs[0], "subs": subs, "notes": notes, "existed": False})
                elif res["code"] == 0:
                    send({"type": "error", "id": self.id, "message": "No subtitles found for those languages. Try other codes, for example en,vi."})
                else:
                    send({"type": "error", "id": self.id, "message": (res["error"] or f"yt-dlp stopped with code {res['code']}")[:300]})
                return
            if res["code"] == 0 and res["path"] and Path(res["path"]).exists():
                if mode == "file" and not subs:
                    notes.append("no subtitles found")
                send({"type": "done", "id": self.id, "path": res["path"], "subs": subs, "notes": notes, "existed": res["existed"]})
            else:
                send({"type": "error", "id": self.id, "message": (res["error"] or f"yt-dlp stopped with code {res['code']}")[:300]})
        except Exception as e:  # noqa: BLE001
            send({"type": "error", "id": self.id, "message": str(e)[:300]})

    def cancel(self):
        self.canceled = True
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()


USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"
MAX_TRACK_BYTES = 12 * 1024 * 1024 * 1024


class MergeTracks:
    """Sites like Bilibili play picture and sound as two separate files. Download both and join them with ffmpeg."""

    def __init__(self, req):
        self.id = req.get("id")
        self.req = req
        self.proc = None
        self.canceled = False

    def cancel(self):
        self.canceled = True
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()

    def _fetch(self, url, dest, label, base, total):
        referer = self.req.get("referer", "")
        headers = {"User-Agent": USER_AGENT}
        if is_http(referer):
            headers["Referer"] = referer
            parsed = urlparse(referer)
            headers["Origin"] = f"{parsed.scheme}://{parsed.netloc}"
        done = 0
        request = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(request, timeout=30) as resp, open(dest, "wb") as out:
            while True:
                chunk = resp.read(1 << 20)
                if not chunk:
                    break
                if self.canceled:
                    raise RuntimeError("canceled")
                done += len(chunk)
                if base + done > MAX_TRACK_BYTES:
                    raise ValueError("The files are unexpectedly large.")
                out.write(chunk)
                send({"type": "progress", "id": self.id, "percent": min(95, int((base + done) * 95 / total)), "note": f"Downloading {label}", "speed": "", "eta": ""})
        return done

    def run(self):
        work = None
        try:
            video_url = self.req.get("video_url", "")
            audio_url = self.req.get("audio_url", "") or ""
            if not is_http(video_url) or (audio_url and not is_http(audio_url)):
                raise ValueError("Only http and https addresses are allowed.")
            ffmpeg = find_tool("ffmpeg")
            if not ffmpeg:
                raise ValueError("ffmpeg is not installed. Run the install command again.")
            OUT_DIR.mkdir(parents=True, exist_ok=True)
            work = Path(tempfile.mkdtemp(prefix="vdh-tracks-"))
            sizes = [n for n in (self.req.get("sizes") or []) if isinstance(n, (int, float)) and n > 0]
            total = max(1, int(sum(sizes))) if sizes else 1 << 30
            video = work / "video.bin"
            audio = work / "audio.bin"
            got = self._fetch(video_url, video, "picture", 0, total)
            if audio_url:
                self._fetch(audio_url, audio, "sound", got, max(total, got + 1))
            if self.canceled:
                return
            send({"type": "progress", "id": self.id, "percent": 96, "note": "Joining picture and sound"})
            stem = unique_base(self.req.get("title", "")) or "video"
            out_path = OUT_DIR / f"{stem}.mp4"
            cmd = [ffmpeg, "-y", "-hide_banner", "-loglevel", "error", "-i", str(video)]
            if audio_url:
                cmd += ["-i", str(audio)]
            cmd += ["-map", "0:v:0"]
            if audio_url:
                cmd += ["-map", "1:a:0"]
            cmd += ["-c", "copy", "-movflags", "+faststart", str(out_path)]
            dbg("running", cmd)
            self.proc = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace", creationflags=NOWINDOW)
            output = self.proc.communicate()[0] or ""
            if self.canceled:
                return
            if self.proc.returncode != 0 or not out_path.exists():
                last = [l for l in output.splitlines() if l.strip()]
                raise ValueError(("ffmpeg could not join the files: " + (last[-1] if last else "unknown error"))[:300])
            send({"type": "done", "id": self.id, "path": str(out_path), "subs": [], "notes": [] if audio_url else ["no sound file found"], "existed": False})
        except Exception as e:  # noqa: BLE001
            dbg("merge failed:", repr(e))
            if not self.canceled:
                send({"type": "error", "id": self.id, "message": str(e)[:300]})
        finally:
            if work:
                shutil.rmtree(work, ignore_errors=True)


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


def update_tools():
    """After the files are swapped: install missing tools (yt-dlp, ffmpeg, deno) and refresh yt-dlp.
    Runs the installer in tools mode and streams what it says so the popup can show progress.
    Failures here never undo the update. Skipped when VDH_SKIP_TOOLS is set."""
    if os.environ.get("VDH_SKIP_TOOLS"):
        return []
    if IS_WINDOWS:
        cmd = ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(ROOT / "host" / "install.ps1"), "-Tools", "-Python", sys.executable]
    else:
        cmd = ["bash", str(ROOT / "host" / "install.sh"), "--tools"]
    lines = []
    try:
        proc = subprocess.Popen(
            cmd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace",
            creationflags=NOWINDOW,
        )
        timer = threading.Timer(600, proc.kill)
        timer.start()
        try:
            for line in proc.stdout:
                line = line.strip()
                if line:
                    lines.append(line)
                    send({"type": "progress", "note": line[:90]})
            proc.wait()
        finally:
            timer.cancel()
        if proc.returncode != 0:
            lines.append("Tool step stopped early")
    except Exception as e:  # noqa: BLE001
        lines.append(f"Tool step skipped: {str(e)[:80]}")
    keep = re.compile(r"(installed|updated|up to date|skipp|could not|not found|stopped early|no javascript)", re.IGNORECASE)
    return [l[:90] for l in lines if keep.search(l)][:4]


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
                subprocess.run(refresh, check=True, capture_output=True, timeout=90, creationflags=NOWINDOW, stdin=subprocess.DEVNULL)
            except Exception:
                for old, bak in backups:  # put the previous copy back
                    shutil.rmtree(old, ignore_errors=True)
                    bak.rename(old)
                raise
            for _, bak in backups:
                shutil.rmtree(bak, ignore_errors=True)
        finally:
            shutil.rmtree(work, ignore_errors=True)
        send({"type": "progress", "note": f"Files updated to {new_version}"})
        notes = update_tools()
        send({"type": "updated", "version": new_version, "notes": notes})
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
        subprocess.run(["explorer.exe", f"/select,{target}"], check=False, creationflags=NOWINDOW, stdin=subprocess.DEVNULL)  # exits 1 even on success
    else:
        subprocess.run(["open", "-R", str(target)], check=False, stdin=subprocess.DEVNULL)
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
            send({
                "type": "pong",
                "ytdlp": tool_version("yt-dlp"),
                "ytdlp_path": find_tool("yt-dlp"),
                "ffmpeg": bool(find_tool("ffmpeg")),
                "ffmpeg_path": find_tool("ffmpeg"),
                "jsruntime": "deno" if find_tool("deno") else ("node" if find_tool("node") else None),
                "version": installed_version(),
                "installed": is_installed_copy(),
            })
            # a ping connection is short lived; keep looping until Chrome disconnects
        elif cmd == "download" and current is None:
            current = Download(msg)
            threading.Thread(target=current.run, daemon=True).start()
        elif cmd == "merge_tracks" and current is None:
            current = MergeTracks(msg)
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
