#!/usr/bin/env bash
# Video Download Helper: one-line installer (macOS).
#
#   curl -fsSL https://raw.githubusercontent.com/kinhsman/video-download-helper/main/install.sh | bash
#
# What it does:
#   1. Downloads the latest extension + helper into ~/.video-download-helper
#   2. Registers the optional yt-dlp helper with Chrome (and other Chromium browsers)
#   3. Opens chrome://extensions so you can Load unpacked (Chrome does not allow scripts to do that step)
# Fully non-interactive. Missing yt-dlp / ffmpeg are installed with Homebrew if you have it.
# Set VDH_NO_INSTALL=1 to forbid that, VDH_SKIP_TOOLS=1 to skip them.
# Re-run it any time to update. Nothing outside your home folder is touched.
set -euo pipefail

REPO="${VDH_REPO:-kinhsman/video-download-helper}"
BRANCH="${VDH_BRANCH:-main}"
DEST="${VDH_HOME:-$HOME/.video-download-helper}"

say() { printf '%s\n' "$*"; }
die() { printf 'Error: %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || die "this installer is for macOS."
for t in curl tar python3; do command -v "$t" >/dev/null 2>&1 || die "$t is required."; done

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

if [ -n "${VDH_SRC_DIR:-}" ]; then
  say "Using local source: $VDH_SRC_DIR"
  mkdir -p "$TMP/src"
  cp -R "$VDH_SRC_DIR/extension" "$VDH_SRC_DIR/host" "$VDH_SRC_DIR/version.json" "$VDH_SRC_DIR/extension-id.txt" "$TMP/src/"
else
  say "Downloading $REPO ($BRANCH)..."
  mkdir -p "$TMP/src"
  curl -fsSL "https://codeload.github.com/$REPO/tar.gz/refs/heads/$BRANCH" | tar -xz -C "$TMP/src" --strip-components=1
fi

for f in extension/manifest.json host/video_helper_host.py host/install.sh version.json extension-id.txt; do
  [ -e "$TMP/src/$f" ] || die "download looks incomplete (missing $f)."
done

NEW_VERSION="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["version"])' "$TMP/src/version.json")"
OLD_VERSION="none"
[ -f "$DEST/version.json" ] && OLD_VERSION="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["version"])' "$DEST/version.json" 2>/dev/null || echo unknown)"

mkdir -p "$DEST"
for d in extension host; do
  rm -rf "$DEST/$d"
  cp -R "$TMP/src/$d" "$DEST/$d"
done
cp "$TMP/src/version.json" "$TMP/src/extension-id.txt" "$DEST/"
for f in README.md LICENSE; do [ -f "$TMP/src/$f" ] && cp "$TMP/src/$f" "$DEST/" || true; done

say ""
bash "$DEST/host/install.sh"

say ""
if [ "$OLD_VERSION" = "none" ]; then
  say "Installed version $NEW_VERSION to $DEST"
  say ""
  say "Last step, in Chrome:"
  say "  1. chrome://extensions  ->  turn on Developer mode (top right)"
  say "  2. Load unpacked  ->  pick this folder:"
  say "       $DEST/extension"
  say "  3. Click the extension icon, press Enable helper, accept the prompt."
  if [ -z "${VDH_NO_OPEN:-}" ] && [ -d "/Applications/Google Chrome.app" ]; then
    open -a "Google Chrome" "chrome://extensions" 2>/dev/null || true
  fi
else
  say "Updated $OLD_VERSION -> $NEW_VERSION in $DEST"
  say "Now reload the extension: chrome://extensions, press the reload arrow on Video Download Helper."
fi
