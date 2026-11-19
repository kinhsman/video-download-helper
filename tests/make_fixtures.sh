#!/usr/bin/env bash
# Builds local test media: a plain mp4, a plain HLS stream, an AES-128 encrypted HLS stream,
# and a test page that loads them. Serve with: python3 -m http.server 8791 --directory tests/fixtures
set -euo pipefail
PYBIN="$(command -v python3 || command -v python)"
export PATH="$HOME/.local/bin:/opt/homebrew/bin:$PATH"
OUT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/fixtures"
mkdir -p "$OUT/hls" "$OUT/hls_enc"
cd "$OUT"

SRC=(-f lavfi -i "testsrc2=size=640x360:rate=25:duration=20" -f lavfi -i "sine=frequency=440:duration=20" -c:v libx264 -preset veryfast -pix_fmt yuv420p -g 50 -c:a aac -b:a 96k)

ffmpeg -y -loglevel error "${SRC[@]}" -movflags +faststart sample.mp4

ffmpeg -y -loglevel error -i sample.mp4 -c copy -f hls -hls_time 4 -hls_playlist_type vod \
  -hls_segment_filename "hls/seg%03d.ts" hls/index.m3u8

# AES-128: key file + keyinfo
openssl rand 16 > hls_enc/enc.key
printf 'enc.key\nhls_enc/enc.key\n' > hls_enc/keyinfo.txt
ffmpeg -y -loglevel error -i sample.mp4 -c copy -f hls -hls_time 4 -hls_playlist_type vod \
  -hls_key_info_file hls_enc/keyinfo.txt -hls_segment_filename "hls_enc/seg%03d.ts" hls_enc/index.m3u8

# master playlist pointing at the plain stream
cat > master.m3u8 <<'EOF'
#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=1200000,RESOLUTION=640x360
hls/index.m3u8
EOF

# a DASH-style site: manifest plus tiny chunks served as .mp4
mkdir -p dash
printf '<?xml version="1.0"?><MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static"></MPD>' > dash/manifest.mpd
head -c 300000 /dev/urandom > dash/seg-1.mp4
head -c 300000 /dev/urandom > dash/chunk_2.mp4
# a copy-protected DASH stream: manifest with Widevine + the track it points at, and a lone file named like a DRM track
mkdir -p dash/drm
cat > dash/drm.mpd <<'XML'
<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT45M10.5S"><Period><AdaptationSet>
<ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"/>
<Representation id="v"><BaseURL>drm/video_480.mp4?token=abc</BaseURL></Representation>
</AdaptationSet></Period></MPD>
XML
head -c 1500000 /dev/urandom > dash/drm/video_480.mp4
head -c 1500000 /dev/urandom > dash/clip_drm_480.mp4
# a short promo manifest and one big file, to test hiding previews
printf '<?xml version="1.0"?><MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT4S"></MPD>' > dash/promo.mpd
head -c 25000000 /dev/urandom > big.mp4

echo '{"version":"99.0.0","notes":"Test update."}' > newer-version.json
echo "{\"version\":\"$("${PYBIN:-python3}" -c 'import json;print(json.load(open("../../extension/manifest.json"))["version"])')\",\"notes\":\"\"}" > same-version.json

cat > plain.html <<'EOF'
<!doctype html>
<title>VDH plain page</title>
<video src="sample.mp4" controls width="320" muted></video>
EOF

cat > index.html <<'EOF'
<!doctype html>
<title>VDH test page</title>
<h1>VDH test page</h1>
<video id="v" src="sample.mp4" controls width="320" muted></video>
<script>
  // Load HLS playlists the way a player would, so the extension sees them.
  fetch('master.m3u8').then(r => r.text());
  fetch('hls_enc/index.m3u8').then(r => r.text());
  fetch('drm/index.m3u8').then(r => r.text());
  fetch('dash/manifest.mpd').then(r => r.text());
  fetch('dash/seg-1.mp4').then(r => r.arrayBuffer());
  fetch('dash/chunk_2.mp4').then(r => r.arrayBuffer());
  fetch('dash/drm.mpd').then(r => r.text());
  fetch('dash/promo.mpd').then(r => r.text());
  fetch('big.mp4').then(r => r.arrayBuffer());
  fetch('dash/drm/video_480.mp4?token=abc').then(r => r.arrayBuffer());
  fetch('dash/clip_drm_480.mp4').then(r => r.arrayBuffer());
</script>
EOF
echo "fixtures ready in $OUT"
