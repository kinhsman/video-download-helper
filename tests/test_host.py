#!/usr/bin/env python3
"""Talks to the helper the way Chrome does (length-prefixed JSON over stdio).

Needs the fixtures server running:
    bash tests/make_fixtures.sh && python3 tests/range_server.py 8791 tests/fixtures
Run:  python3 tests/test_host.py
"""
import json
import shutil
import struct
import subprocess
import sys
from pathlib import Path

HOST = Path(__file__).resolve().parent.parent / "host" / "video_helper_host.py"


def frame(obj):
    data = json.dumps(obj).encode()
    return struct.pack("=I", len(data)) + data


def read_one(stdout):
    raw = stdout.read(4)
    if len(raw) < 4:
        return None
    (n,) = struct.unpack("=I", raw)
    return json.loads(stdout.read(n))


def talk(request):
    """Send one request, keep the connection open (like Chrome) until a final reply, then disconnect."""
    p = subprocess.Popen([sys.executable, str(HOST)], stdin=subprocess.PIPE, stdout=subprocess.PIPE)
    p.stdin.write(frame(request))
    p.stdin.flush()
    msgs = []
    while True:
        m = read_one(p.stdout)
        if m is None:
            break
        msgs.append(m)
        if m["type"] in ("pong", "done", "error"):
            break
    p.stdin.close()
    p.wait(timeout=30)
    return msgs


def check(name, cond, extra=""):
    print(("PASS " if cond else "FAIL ") + name + (f"  {extra}" if extra and not cond else ""))
    if not cond:
        check.failed += 1


check.failed = 0

r = talk({"cmd": "ping"})
check("ping returns pong with yt-dlp", r and r[0]["type"] == "pong" and r[0]["ytdlp"], r)

for bad in ("file:///etc/passwd", "ftp://example.com/x", "javascript:alert(1)", ""):
    r = talk({"cmd": "download", "id": "t", "url": bad, "quality": "best"})
    check(f"rejects {bad or 'empty url'}", r and r[-1]["type"] == "error", r)

r = talk({"cmd": "download", "id": "t", "url": "http://localhost:8791/sample.mp4", "quality": "bogus"})
check("rejects unknown quality", r and r[-1]["type"] == "error", r)

r = talk({"cmd": "download", "id": "t1", "url": "http://localhost:8791/sample.mp4", "quality": "720", "referer": "http://localhost:8791/"})
check("downloads a direct mp4 through yt-dlp", r and r[-1]["type"] == "done" and Path(r[-1]["path"]).exists(), r)
if r and r[-1]["type"] == "done":
    print("   saved:", r[-1]["path"])

r = talk({"cmd": "download", "id": "t2", "url": "http://localhost:8791/hls/index.m3u8", "quality": "best"})
check("downloads an HLS stream through yt-dlp", r and r[-1]["type"] == "done" and Path(r[-1]["path"]).exists(), r)
if r and r[-1]["type"] == "done":
    print("   saved:", r[-1]["path"])

# stream links are named after the page, and a second save does not collide
made = []
for n, expect in ((1, "VDH Test Clip.mp4"), (2, "VDH Test Clip (2).mp4")):
    r = talk({"cmd": "download", "id": f"n{n}", "url": "http://127.0.0.1:8791/sample.mp4", "quality": "best", "title": "VDH Test Clip", "named": True})
    ok = bool(r) and r[-1]["type"] == "done" and Path(r[-1]["path"]).name == expect and Path(r[-1]["path"]).exists()
    check(f"named download #{n} is called {expect}", ok, r)
    if r and r[-1]["type"] == "done":
        made.append(Path(r[-1]["path"]))

# --- sound only. sample.mp4 is one combined file, the case where a shared name would cost the saved video
ffprobe = shutil.which("ffprobe") or str(Path.home() / ".local" / "bin" / "ffprobe")


def streams(path):
    """What is inside a file, as ["audio:mp3", ...]."""
    out = subprocess.run([ffprobe, "-v", "error", "-show_entries", "stream=codec_type,codec_name:stream_disposition=attached_pic", "-of", "json", str(path)], capture_output=True, text=True).stdout
    return sorted(f"{s['codec_type']}:{s['codec_name']}" for s in json.loads(out or "{}").get("streams", []))


video = Path.home() / "Downloads" / "VideoHelper" / "sample [sample].mp4"
for quality, ext, codec in (("mp3", "mp3", "mp3"), ("m4a", "m4a", "aac"), ("audio", "m4a", "aac")):
    for turn in ("first", "second"):
        r = talk({"cmd": "download", "id": f"a-{quality}", "url": "http://localhost:8791/sample.mp4", "quality": quality})
        saved = Path(r[-1]["path"]) if r and r[-1]["type"] == "done" else None
        ok = bool(saved) and saved.exists() and saved.name == f"sample [sample] (audio).{ext}"
        check(f"{quality}, {turn} save: writes sample [sample] (audio).{ext}", ok, r[-3:] if r else r)
        if ok:
            check(f"{quality}, {turn} save: holds {codec} sound and no picture", streams(saved) == [f"audio:{codec}"], streams(saved))
        check(f"{quality}, {turn} save: the saved video is untouched", video.exists() and streams(video) == ["audio:aac", "video:h264"])
    if saved:
        saved.unlink(missing_ok=True)

r = talk({"cmd": "download", "id": "an", "url": "http://127.0.0.1:8791/sample.mp4", "quality": "mp3", "title": "VDH Test Clip", "named": True})
named_audio = Path(r[-1]["path"]) if r and r[-1]["type"] == "done" else None
check("a named sound download keeps the (audio) ending", bool(named_audio) and named_audio.name == "VDH Test Clip (audio).mp3", r[-3:] if r else r)
if named_audio:
    made.append(named_audio)

r = talk({"cmd": "reveal", "path": "/etc/hosts"})
check("reveal refuses files outside the VideoHelper folder", r and r[-1]["type"] == "error", r)
r = talk({"cmd": "reveal", "path": str(Path.home() / "Downloads" / "VideoHelper" / "nope.mp4")})
check("reveal reports a missing file", r and r[-1]["type"] == "error" and "moved or deleted" in r[-1]["message"], r)

# --- picture and sound as two files, joined with ffmpeg (needs the range server's tracks fixture)
r = talk({"cmd": "merge_tracks", "id": "m1", "video_url": "http://127.0.0.1:8791/tracks/video.m4s", "audio_url": "http://127.0.0.1:8791/tracks/audio.m4s", "referer": "http://127.0.0.1:8791/tracks.html", "title": "VDH Merge Test", "sizes": [2000000, 170000]})
joined = Path(r[-1]["path"]) if r and r[-1]["type"] == "done" else None
check("merge_tracks joins picture and sound into one mp4", bool(joined) and joined.exists() and joined.name == "VDH Merge Test.mp4", r[-3:] if r else r)
if joined and joined.exists():
    out = subprocess.run([ffprobe, "-v", "error", "-show_entries", "stream=codec_type", "-of", "csv=p=0", str(joined)], capture_output=True, text=True).stdout.split()
    check("the joined file has both a picture and a sound stream", sorted(out) == ["audio", "video"], out)
    joined.unlink()
r = talk({"cmd": "merge_tracks", "id": "m2", "video_url": "file:///etc/passwd", "audio_url": "", "title": "x"})
check("merge_tracks refuses non-http addresses", r and r[-1]["type"] == "error", r)

# --- with a stand-in yt-dlp: cookie fallback, subtitles, YouTube runtime flag (not on Windows: needs a script launcher)
if sys.platform != "win32":
    import os, tempfile, stat
    fake_dir = Path(tempfile.mkdtemp(prefix="vdh-fake-"))
    fake = fake_dir / "fake_yt_dlp.py"
    fake.write_text(r'''#!/usr/bin/env python3
import os, sys, pathlib
a = sys.argv[1:]
open(os.environ["FAKE_ARGS_FILE"], "a").write(" ".join(a) + "\n")
out = pathlib.Path.home() / "Downloads" / "VideoHelper"
out.mkdir(parents=True, exist_ok=True)
if "--cookies-from-browser" in a:
    print("ERROR: Could not copy Chrome cookie database. See https://github.com/yt-dlp/yt-dlp/issues/7271 for more info")
    sys.exit(1)
pf = a[a.index("--print-to-file") + 2]
only = "--skip-download" in a
print("[youtube] Extracting URL: x")
if "--write-subs" in a:
    for lang in a[a.index("--sub-langs") + 1].split(","):
        if lang == "zz":
            continue
        f = out / f"fake-video.{lang}.vtt"
        f.write_text("WEBVTT\n")
        print(f"[info] Writing video subtitles to: {f}")
        if "--convert-subs" in a:
            f.rename(f.with_suffix(".srt"))
if not only:
    v = out / "fake-video.mp4"
    v.write_bytes(b"x" * 100)
    open(pf, "a").write(str(v) + "\n")
print("PROGRESS|100%|1MiB/s|00:00")
''')
    fake.chmod(fake.stat().st_mode | stat.S_IEXEC)
    args_file = fake_dir / "args.txt"
    os.environ["VDH_TOOL_YT_DLP"] = str(fake)
    os.environ["FAKE_ARGS_FILE"] = str(args_file)
    base = {"cmd": "download", "id": "f", "url": "http://127.0.0.1:8791/x", "quality": "best"}
    outdir = Path.home() / "Downloads" / "VideoHelper"

    def last_args():
        return args_file.read_text().splitlines()[-1] if args_file.exists() else ""

    r = talk({**base, "cookies": True})
    check("Chrome cookie lock: retries without the login and still saves", r and r[-1]["type"] == "done" and "without your Chrome login" in r[-1].get("notes", []), r)
    check("the retry really dropped the cookie option", "--cookies-from-browser" not in last_args(), last_args())
    check("YouTube JavaScript runtime is passed when one exists", "--js-runtimes" in last_args(), last_args())

    r = talk({**base, "subs": {"mode": "file", "langs": "en,vi"}})
    check("subtitles as files: both languages saved as .srt", r and r[-1]["type"] == "done" and sorted(Path(p).name for p in r[-1].get("subs", [])) == ["fake-video.en.srt", "fake-video.vi.srt"], r)
    check("subtitle options reach yt-dlp", all(x in last_args() for x in ("--write-subs", "--write-auto-subs", "--sub-langs en,vi", "--convert-subs srt")), last_args())

    for f in outdir.glob("fake-video*"):
        f.unlink()
    r = talk({**base, "subs": {"mode": "only", "langs": "en"}})
    check("subtitles only: saves the .srt and no video", r and r[-1]["type"] == "done" and r[-1]["path"].endswith("fake-video.en.srt") and not (outdir / "fake-video.mp4").exists(), r)
    check("subtitles only skips the video download", "--skip-download" in last_args(), last_args())

    r = talk({**base, "subs": {"mode": "only", "langs": "zz"}})
    check("subtitles only with no match gives a clear error", r and r[-1]["type"] == "error" and "No subtitles found" in r[-1]["message"], r)

    r = talk({**base, "subs": {"mode": "file", "langs": "en; rm -rf /"}})
    check("odd language text is refused", r and r[-1]["type"] == "error" and "look wrong" in r[-1]["message"], r)

    r = talk({**base, "subs": {"mode": "embed", "langs": "en"}})
    check("embed option reaches yt-dlp", r and r[-1]["type"] == "done" and "--embed-subs" in last_args(), r)

    for f in outdir.glob("fake-video*"):
        f.unlink()
    del os.environ["VDH_TOOL_YT_DLP"]
    shutil.rmtree(fake_dir, ignore_errors=True)

# clean up the files this test created
out = Path.home() / "Downloads" / "VideoHelper"
for f in made + list(out.glob("sample [[]sample[]]*")) + list(out.glob("index [[]index[]]*")):
    f.unlink(missing_ok=True)
try:
    out.rmdir()
except OSError:
    pass

print("progress messages seen:", sum(1 for m in r if m["type"] == "progress"))
sys.exit(1 if check.failed else 0)
