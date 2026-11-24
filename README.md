# Video Download Helper

Chrome extension that finds videos on the page you are watching and saves them with one click.
macOS, Chrome and other Chromium browsers.

## Install (one command)

```bash
curl -fsSL https://raw.githubusercontent.com/kinhsman/video-download-helper/main/install.sh | bash
```

That downloads the extension and the helper into `~/.video-download-helper`, registers the helper with your browser, and opens `chrome://extensions`. Then the one step Chrome does not let a script do:

1. Turn on Developer mode (top right).
2. Press Load unpacked and pick `~/.video-download-helper/extension`.
3. Click the extension icon, press Enable helper, accept the prompt.

Read `install.sh` first if you like. It never asks questions. It writes inside your home folder, and installs yt-dlp and ffmpeg with Homebrew if you have it and they are missing. Set `VDH_NO_INSTALL=1` to stop it installing anything, or `VDH_SKIP_TOOLS=1` to skip yt-dlp and ffmpeg.

## Updates

The extension checks for a new version once a day. When there is one, the popup shows a banner and a notification.
Press Update now: it swaps the extension and helper files, installs any missing tools (yt-dlp, ffmpeg, deno) and refreshes yt-dlp, showing progress as it goes, then the extension reloads itself on the new version. This can take a minute or two. No helper? The banner shows the same install command, run it again and press the reload arrow on the extension.

## What it does

- Finds plain video files (mp4, webm, mov...) and HLS streams (m3u8) the page loads.
- Plain files are saved straight through Chrome.
- HLS streams are downloaded, joined and converted to mp4 inside the browser. Normal AES-128 encrypted HLS works.
- Locked streams (the kind that only play inside the site's own player) are shown as "protected" and skipped.
- Groups a stream's picture, sound and playlist files into one entry, and hides previews, ads and short clips (one click shows them).
- Sites that play picture and sound as two separate files (Bilibili, for example) show as one card, "Picture + sound, 2 files". The helper downloads both and joins them with ffmpeg into one mp4. It needs the video to have played for a few seconds so both files were requested.
- Optional helper (yt-dlp + ffmpeg) for what a browser cannot do: YouTube-style sites, DASH streams, live streams, very big files, HLS with a separate audio file.
- Subtitles for YouTube and other yt-dlp sites (needs the helper): save them as `.srt` files, put them inside the video, or download subtitles only. Pick languages by code, for example `en,vi,th`. Auto-generated captions are included.
- YouTube needs a JavaScript runtime for yt-dlp. The installer adds deno if you have neither deno nor node.
- Files land in `Downloads/VideoHelper/`. Each finished download has a Show in folder link.
- Also: toolbar badge count, Force detect, right-click "Download this video", finish notification, recent history.

## The popup

The layout follows a design made in Claude Design (Meadow look, light and dark). The Recommended card is the one-click choice (full video with sound). Other streams are listed under Other downloads, files that could not be read fold into one line with a Scan again button, and previews or ads are hidden behind a button. This page and Downloads are two tabs, progress sits inside the row that started it. The footer shows a helper status dot (click it for details) and a real button: Check for updates, which turns into Update available.

## Using it

1. Open a page with a video and press play (some sites only load the video once it plays).
2. Click the toolbar icon. Videos found on the tab are listed with type, size and quality.
3. Press Download. Progress shows under Downloads in the popup.
4. Nothing found? Press Force detect.
5. With the helper enabled, "Whole page (yt-dlp)" downloads the page's video even when the extension could not see the file.
   "Use my Chrome login" passes your Chrome cookies to yt-dlp (macOS will ask for Keychain access). While Chrome is open it often locks its cookie file; the helper then carries on without the login and says so.
6. Subtitles: pick an option under Whole page and type language codes (`en,vi`). "Subtitles only" saves just the `.srt` files.

## Known limits

- HLS transport-stream videos are converted to fragmented mp4. It plays in Chrome, VLC, QuickTime and most editors. If a tool balks: `ffmpeg -i in.mp4 -c copy out.mp4`.
- HLS with the audio in a separate file, live streams and DASH need the helper.
- If a stream is not H.264 + AAC the file is saved as `.ts`.
- Hiding previews is a guess based on length and size.
- Sites that sign requests with short-lived tokens may need Force detect before downloading.
- Chrome Web Store rules do not allow this kind of tool, so it stays unpacked and updates through the helper.

## Legal

For saving videos you have the right to keep. Respect each site's terms and copyright. Provided as is, no warranty (MIT).

## Uninstall

```bash
rm -rf ~/.video-download-helper
rm -f ~/Library/Application\ Support/*/NativeMessagingHosts/com.sang.video_helper.json \
      ~/Library/Application\ Support/*/*/NativeMessagingHosts/com.sang.video_helper.json
```

Then remove the extension in `chrome://extensions`.

## Layout

```
install.sh   the one-line installer
version.json the published version (the extension compares itself against this)
extension/   Chrome extension (Manifest V3, no build step)
  background.js  detection, routing, jobs, helper link, update check
  content.js     finds <video> tags and og:video the network sniffer can miss
  offscreen.js   HLS engine (playlist, segments, AES-128, mux.js to mp4)
  popup.*        toolbar popup
  repo.json      where updates come from
  lib/hls.js     playlist parser, lib/mux.min.js is mux.js 7.1.0 (Apache-2.0)
host/        optional native helper (Python, wraps yt-dlp and ffmpeg)
tests/       fixtures, parser, helper, installer and end-to-end tests
```

## Releasing a new version

Bump `version` in `extension/manifest.json` and `version.json` (they must match), commit and push to `main`. Installed copies see it within a day.

## Tests

```bash
bash tests/make_fixtures.sh                       # builds test media
python3 tests/range_server.py 8791 tests/fixtures &
node tests/test_parser.mjs                        # playlist parser
python3 tests/test_host.py                        # helper protocol and yt-dlp runs
python3 tests/test_install.py                     # installer and self-update in a throwaway HOME
node tests/e2e.mjs                                # loads the extension in Chrome for Testing, downloads real files
```

The end-to-end test uses Playwright's Chrome for Testing (`~/Library/Caches/ms-playwright`), because current branded Chrome ignores `--load-extension`. Set `CHROME=/path/to/binary` to use another build.
