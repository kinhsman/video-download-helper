#!/usr/bin/env bash
# Registers the optional yt-dlp helper with Chrome and other Chromium browsers (macOS).
# Safe to re-run. Fully non-interactive: installs yt-dlp and ffmpeg with Homebrew when missing.
#   VDH_NO_INSTALL=1 forbids installing anything, VDH_SKIP_TOOLS=1 skips yt-dlp and ffmpeg
#   --refresh   non-interactive: only rewrite the launcher and browser registration
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"
HOST_NAME="com.sang.video_helper"
EXT_ID="$(tr -d '[:space:]' < "$ROOT/extension-id.txt")"
SUPPORT="$HOME/Library/Application Support"
REFRESH=0
[ "${1:-}" = "--refresh" ] && REFRESH=1
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

PY="$(command -v python3 || true)"
if [ -z "$PY" ] || ! "$PY" -c 'import sys' >/dev/null 2>&1; then
  echo "python3 not found or not working. Install it first (brew install python)."
  exit 1
fi

if [ "$REFRESH" = 0 ] && [ -z "${VDH_SKIP_TOOLS:-}" ]; then
  for tool in yt-dlp ffmpeg; do
    command -v "$tool" >/dev/null 2>&1 && continue
    echo "$tool is not installed (needed for YouTube-style sites)."
    if [ -n "${VDH_NO_INSTALL:-}" ]; then
      echo "  Skipping (VDH_NO_INSTALL is set). Later: brew install $tool"
    elif command -v brew >/dev/null 2>&1; then
      echo "  Installing $tool with Homebrew..."
      HOMEBREW_NO_ENV_HINTS=1 brew install "$tool" || echo "  Could not install $tool. Later: brew install $tool"
    else
      echo "  Homebrew is not installed. Get it from https://brew.sh, then run: brew install $tool"
    fi
  done
fi

# Remember where the tools are, because the browser's own PATH can be older than ours.
if [ "$REFRESH" = 0 ]; then
  "$PY" - "$ROOT/tools.json" <<'PYTOOLS'
import json, shutil, sys
found = {n: shutil.which(n) for n in ("yt-dlp", "ffmpeg") if shutil.which(n)}
json.dump(found, open(sys.argv[1], "w"))
for n in ("yt-dlp", "ffmpeg"):
    print(f"Found {n}: {found[n]}" if n in found else f"{n} not found (only needed for YouTube-style sites).")
PYTOOLS
fi

# Launcher so Chrome (which starts us with a bare PATH) always finds python.
WRAPPER="$HERE/run_host.sh"
cat > "$WRAPPER" <<EOF
#!/bin/bash
export PATH="\$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:\$PATH"
exec "$PY" "$HERE/video_helper_host.py"
EOF
chmod +x "$WRAPPER" "$HERE/video_helper_host.py"

# Register with every Chromium browser that is installed.
registered=0
for dir in \
  "Google/Chrome" "Google/Chrome Beta" "Google/Chrome Canary" "Chromium" \
  "BraveSoftware/Brave-Browser" "Microsoft Edge" "Vivaldi"; do
  if [ -d "$SUPPORT/$dir" ] || [ "$dir" = "Google/Chrome" ]; then
    nm="$SUPPORT/$dir/NativeMessagingHosts"
    mkdir -p "$nm"
    cat > "$nm/$HOST_NAME.json" <<EOF
{
  "name": "$HOST_NAME",
  "description": "Video Download Helper (yt-dlp bridge)",
  "path": "$WRAPPER",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXT_ID/"]
}
EOF
    registered=$((registered + 1))
    [ "$REFRESH" = 0 ] && echo "Registered helper for: $dir"
  fi
done

if [ "$REFRESH" = 0 ]; then
  echo "Helper installed for extension $EXT_ID ($registered browser(s))."
fi
