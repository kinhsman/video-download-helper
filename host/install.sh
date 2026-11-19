#!/usr/bin/env bash
# Registers the optional yt-dlp helper with Chrome and other Chromium browsers (macOS).
# Safe to re-run. Never installs anything without asking.
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

# Prompts must read from the terminal, because this script may itself be fed through a pipe.
ask() {
  local ans=""
  if [ "$REFRESH" = 0 ] && [ -r /dev/tty ] && [ -w /dev/tty ]; then
    read -r -p "$1 [y/N] " ans < /dev/tty || true
  fi
  [[ "$ans" =~ ^[Yy]$ ]]
}

PY="$(command -v python3 || true)"
if [ -z "$PY" ] || ! "$PY" -c 'import sys' >/dev/null 2>&1; then
  echo "python3 not found or not working. Install it first (brew install python)."
  exit 1
fi

if [ "$REFRESH" = 0 ]; then
  for tool in yt-dlp ffmpeg; do
    command -v "$tool" >/dev/null 2>&1 && continue
    echo "$tool is not installed (needed for YouTube-style sites)."
    if command -v brew >/dev/null 2>&1; then
      if [ "${VDH_YES:-0}" = 1 ] || ask "Install $tool with Homebrew now?"; then
        brew install "$tool"
      else
        echo "  Skipped. Later: brew install $tool"
      fi
    else
      echo "  Install Homebrew from https://brew.sh, then run: brew install $tool"
    fi
  done
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
