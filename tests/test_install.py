#!/usr/bin/env python3
"""Tests the one-line installer and the helper's self-update in a throwaway home folder.

macOS: nothing touches your real browser setup or ~/.video-download-helper.
Windows: the installer writes the real per-user registry key, so this only runs in CI
(GITHUB_ACTIONS) or when VDH_TEST_REGISTRY=1 is set, and removes the key when done.

Run:  python3 tests/test_install.py
"""
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
WIN = sys.platform == "win32"
failed = 0

if WIN and not (os.environ.get("GITHUB_ACTIONS") or os.environ.get("VDH_TEST_REGISTRY")):
    print("SKIP: on Windows this test edits the registry. Set VDH_TEST_REGISTRY=1 to run it anyway.")
    sys.exit(0)


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
    p.wait(timeout=60)
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


def run_installer(env):
    if WIN:
        cmd = ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(ROOT / "install.ps1")]
    else:
        cmd = ["bash", str(ROOT / "install.sh")]
    return subprocess.run(cmd, env=env, capture_output=True, text=True, stdin=subprocess.DEVNULL, timeout=300)


def registry_default(key_path):
    import winreg
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, key_path) as k:
            return winreg.QueryValueEx(k, "")[0]
    except OSError:
        return None


REG_KEY = r"Software\Google\Chrome\NativeMessagingHosts\com.sang.video_helper"

with tempfile.TemporaryDirectory() as tmp:
    home = Path(tmp) / "home"
    home.mkdir()
    env = {**os.environ, "HOME": str(home), "USERPROFILE": str(home), "VDH_SRC_DIR": str(ROOT), "VDH_NO_OPEN": "1", "VDH_SKIP_TOOLS": "1"}
    dest = home / ".video-download-helper"

    try:
        # 1. fresh install
        r = run_installer(env)
        check("installer exits cleanly", r.returncode == 0, r.stdout[-600:] + r.stderr[-600:])
        check("installer tells the user to Load unpacked with the folder", "Load unpacked" in r.stdout and str(dest / "extension") in r.stdout, r.stdout[-400:])
        check("extension copied", (dest / "extension" / "manifest.json").exists())
        launcher_path = dest / ("run_host.bat" if WIN else "host/run_host.sh")
        check("helper copied and launcher written", (dest / "host" / "video_helper_host.py").exists() and launcher_path.exists())
        if not WIN:
            check("launcher is executable", os.access(launcher_path, os.X_OK))
        check("private key never copied", not any(dest.rglob("key.pem")))

        ext_id = (ROOT / "extension-id.txt").read_text().strip()
        if WIN:
            manifest_file = dest / "com.sang.video_helper.json"
            check("browser registry key points at the manifest", registry_default(REG_KEY) == str(manifest_file), registry_default(REG_KEY))
        else:
            manifest_file = home / "Library/Application Support/Google/Chrome/NativeMessagingHosts/com.sang.video_helper.json"
        manifest = json.loads(manifest_file.read_text(encoding="utf-8")) if manifest_file.exists() else {}
        check("registration points at the installed launcher", manifest.get("path") == str(launcher_path), manifest)
        check("registration only allows this extension", manifest.get("allowed_origins") == [f"chrome-extension://{ext_id}/"], manifest)

        launcher = [str(launcher_path)]
        pong = talk(launcher, {"cmd": "ping"}, env)
        check("installed helper answers ping and knows it is the installed copy", pong.get("type") == "pong" and pong.get("installed") is True and pong.get("version"), pong)

        # 2. update from the helper
        tgz = Path(tmp) / "new.tar.gz"
        make_release("9.9.9", tgz)
        uenv = {**env, "VDH_UPDATE_URL": tgz.as_uri()}
        msg = talk(launcher, {"cmd": "update"}, uenv)
        check("update succeeds and reports the new version", msg.get("type") == "updated" and msg.get("version") == "9.9.9", msg)
        check("extension files were replaced", json.loads((dest / "extension" / "manifest.json").read_text())["version"] == "9.9.9")
        check("version file updated", json.loads((dest / "version.json").read_text())["version"] == "9.9.9")
        check("no leftover backup folders", not list(dest.glob(".old-*")))
        check("launcher survived the update", launcher_path.exists())
        pong = talk(launcher, {"cmd": "ping"}, env)
        check("helper still works after updating itself", pong.get("type") == "pong" and pong.get("version") == "9.9.9", pong)

        # 3. a broken download leaves the installed copy alone
        bad = Path(tmp) / "bad.tar.gz"
        make_release("10.0.0", bad, drop="version.json")
        msg = talk(launcher, {"cmd": "update"}, {**env, "VDH_UPDATE_URL": bad.as_uri()})
        check("incomplete download is rejected", msg.get("type") == "error", msg)
        check("installed copy untouched after a bad update", json.loads((dest / "extension" / "manifest.json").read_text())["version"] == "9.9.9" and (dest / "host" / "video_helper_host.py").exists())

        # 4. plain http update address is refused
        msg = talk(launcher, {"cmd": "update"}, {**env, "VDH_UPDATE_URL": "http://example.com/x.tar.gz"})
        check("non-https update address is refused", msg.get("type") == "error", msg)

        # 5. a development checkout never updates itself
        msg = talk([sys.executable, str(ROOT / "host" / "video_helper_host.py")], {"cmd": "update"}, uenv)
        check("development copy refuses to self-update", msg.get("type") == "error" and "development" in msg.get("message", ""), msg)

        # 6. re-running the installer updates in place and says so
        r = run_installer(env)
        check("re-run reports an update", "Updated 9.9.9" in r.stdout and "reload" in r.stdout.lower(), r.stdout[-300:] + r.stderr[-300:])
    finally:
        if WIN:
            subprocess.run(["reg", "delete", r"HKCU\Software\Google\Chrome\NativeMessagingHosts\com.sang.video_helper", "/f"], capture_output=True)

print(f"\n{failed} check(s) failed" if failed else "\nAll install checks passed")
sys.exit(1 if failed else 0)
