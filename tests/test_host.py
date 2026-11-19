#!/usr/bin/env python3
"""Talks to the helper the way Chrome does (length-prefixed JSON over stdio).

Needs the fixtures server running:
    bash tests/make_fixtures.sh && python3 -m http.server 8791 --directory tests/fixtures
Run:  python3 tests/test_host.py
"""
import json
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

r = talk({"cmd": "reveal", "path": "/etc/hosts"})
check("reveal refuses files outside the VideoHelper folder", r and r[-1]["type"] == "error", r)
r = talk({"cmd": "reveal", "path": str(Path.home() / "Downloads" / "VideoHelper" / "nope.mp4")})
check("reveal reports a missing file", r and r[-1]["type"] == "error" and "moved or deleted" in r[-1]["message"], r)

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
