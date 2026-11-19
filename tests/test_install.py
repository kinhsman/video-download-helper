#!/usr/bin/env python3
"""Tests the one-line installer and the helper's self-update in a throwaway HOME.

Nothing here touches your real browser setup or ~/.video-download-helper.
Run:  python3 tests/test_install.py
"""
import io
import json
import os
import shutil
import struct
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
failed = 0


def check(name, cond, extra=""):
    global failed
    print(("PASS " if cond else "FAIL ") + name + (f"  {extra}" if extra and not cond else ""))
    if not cond:
        failed += 1


def talk(host_cmd, request, env):
    p = subprocess.Popen(host_cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, env=env)
    data = json.dumps(request).encode()
    p.stdin.write(struct.pack("=I", len(data)) + data)
    p.stdin.flush()
    raw = p.stdout.read(4)
    (n,) = struct.unpack("=I", raw)
    msg = json.loads(p.stdout.read(n))
    p.stdin.close()
    p.wait(timeout=30)
    return msg


def make_release(version, dest_tgz, drop=None):
    """A tarball shaped like GitHub's codeload archive: one top folder holding the repo."""
    with tempfile.TemporaryDirectory() as d:
        top = Path(d) / f"video-download-helper-{version}"
        for item in ("extension", "host"):
            shutil.copytree(ROOT / item, top / item, ignore=shutil.ignore_patterns("run_host.sh", "__pycache__"))
        shutil.copy(ROOT / "extension-id.txt", top / "extension-id.txt")
        (top / "version.json").write_text(json.dumps({"version": version, "notes": "test"}))
        m = json.loads((top / "extension" / "manifest.json").read_text())
        m["version"] = version
        (top / "extension" / "manifest.json").write_text(json.dumps(m))
        if drop:
            (top / drop).unlink()
        with tarfile.open(dest_tgz, "w:gz") as tar:
            tar.add(top, arcname=top.name)


with tempfile.TemporaryDirectory() as tmp:
    home = Path(tmp) / "home"
    home.mkdir()
    env = {**os.environ, "HOME": str(home), "VDH_SRC_DIR": str(ROOT), "VDH_NO_OPEN": "1"}
    dest = home / ".video-download-helper"

    # 1. fresh install
    r = subprocess.run(["bash", str(ROOT / "install.sh")], env=env, capture_output=True, text=True, stdin=subprocess.DEVNULL, timeout=120)
    check("installer exits cleanly", r.returncode == 0, r.stdout[-400:] + r.stderr[-400:])
    check("installer tells the user to Load unpacked with the folder", "Load unpacked" in r.stdout and str(dest / "extension") in r.stdout, r.stdout[-400:])
    check("extension copied", (dest / "extension" / "manifest.json").exists())
    check("helper copied and launcher written", (dest / "host" / "run_host.sh").exists() and os.access(dest / "host" / "run_host.sh", os.X_OK))
    check("private key never copied", not any(dest.rglob("key.pem")))
    nm = home / "Library/Application Support/Google/Chrome/NativeMessagingHosts/com.sang.video_helper.json"
    manifest = json.loads(nm.read_text()) if nm.exists() else {}
    ext_id = (ROOT / "extension-id.txt").read_text().strip()
    check("browser registration points at the installed launcher", manifest.get("path") == str(dest / "host" / "run_host.sh"), manifest)
    check("registration only allows this extension", manifest.get("allowed_origins") == [f"chrome-extension://{ext_id}/"], manifest)

    launcher = [str(dest / "host" / "run_host.sh")]
    pong = talk(launcher, {"cmd": "ping"}, env)
    check("installed helper answers ping and knows it is the installed copy", pong.get("type") == "pong" and pong.get("installed") is True and pong.get("version"), pong)

    # 2. update from the helper
    tgz = Path(tmp) / "new.tar.gz"
    make_release("9.9.9", tgz)
    uenv = {**env, "VDH_UPDATE_URL": f"file://{tgz}"}
    msg = talk(launcher, {"cmd": "update"}, uenv)
    check("update succeeds and reports the new version", msg.get("type") == "updated" and msg.get("version") == "9.9.9", msg)
    check("extension files were replaced", json.loads((dest / "extension" / "manifest.json").read_text())["version"] == "9.9.9")
    check("version file updated", json.loads((dest / "version.json").read_text())["version"] == "9.9.9")
    check("no leftover backup folders", not list(dest.glob(".old-*")))
    pong = talk(launcher, {"cmd": "ping"}, env)
    check("helper still works after updating itself", pong.get("type") == "pong" and pong.get("version") == "9.9.9", pong)

    # 3. a broken download leaves the installed copy alone
    bad = Path(tmp) / "bad.tar.gz"
    make_release("10.0.0", bad, drop="version.json")
    msg = talk(launcher, {"cmd": "update"}, {**env, "VDH_UPDATE_URL": f"file://{bad}"})
    check("incomplete download is rejected", msg.get("type") == "error", msg)
    check("installed copy untouched after a bad update", json.loads((dest / "extension" / "manifest.json").read_text())["version"] == "9.9.9" and (dest / "host" / "video_helper_host.py").exists())

    # 4. plain http update address is refused
    msg = talk(launcher, {"cmd": "update"}, {**env, "VDH_UPDATE_URL": "http://example.com/x.tar.gz"})
    check("non-https update address is refused", msg.get("type") == "error", msg)

    # 5. a development checkout never updates itself
    msg = talk([sys.executable, str(ROOT / "host" / "video_helper_host.py")], {"cmd": "update"}, uenv)
    check("development copy refuses to self-update", msg.get("type") == "error" and "development" in msg.get("message", ""), msg)

    # 6. re-running the installer updates in place and says so
    r = subprocess.run(["bash", str(ROOT / "install.sh")], env=env, capture_output=True, text=True, stdin=subprocess.DEVNULL, timeout=120)
    check("re-run reports an update", "Updated 9.9.9" in r.stdout and "reload" in r.stdout.lower(), r.stdout[-300:])

print(f"\n{failed} check(s) failed" if failed else "\nAll install checks passed")
sys.exit(1 if failed else 0)
