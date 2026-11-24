#!/usr/bin/env bash
# Builds local test media: a plain mp4, a plain HLS stream, an AES-128 encrypted HLS stream,
# and a test page that loads them. Serve with: python3 tests/range_server.py 8791 tests/fixtures
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

# a protected stream (never downloadable): the playlist alone is enough
mkdir -p drm
cat > drm/index.m3u8 <<'DRMEOF'
#EXTM3U
#EXT-X-TARGETDURATION:4
#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://fake",KEYFORMAT="com.apple.streamingkeydelivery"
#EXTINF:4,
../hls/seg000.ts
#EXT-X-ENDLIST
DRMEOF

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
# a protected DASH stream: manifest with Widevine + the track it points at, and a lone file named like a protected track
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

# Bilibili-style: picture and sound as two separate fragmented mp4 files named .m4s, fetched in byte ranges
mkdir -p tracks
ffmpeg -y -loglevel error -i sample.mp4 -an -c:v copy -movflags frag_keyframe+empty_moov+default_base_moof -f mp4 tracks/video.m4s
ffmpeg -y -loglevel error -i sample.mp4 -vn -c:a copy -movflags frag_keyframe+empty_moov+default_base_moof -f mp4 tracks/audio.m4s
head -c 50000 /dev/urandom > tracks/seg1.m4s   # a small stream chunk that must be ignored
cat > tracks.html <<'TRACKSEOF'
<!doctype html>
<meta charset="utf-8">
<title>Split tracks page</title>
<script>
  // what a player does: ask for a slice of each file
  for (const f of ['tracks/video.m4s', 'tracks/audio.m4s']) fetch(f, { headers: { Range: 'bytes=0-65535' } }).then(r => r.arrayBuffer());
  fetch('tracks/seg1.m4s').then(r => r.arrayBuffer());
</script>
TRACKSEOF

# QA page: awkward cases for the popup (long non-Latin title, separate-audio streams, live, unreadable playlist)
mkdir -p qa
"$PYBIN" - <<'PY'
def media(name, live=False, n=160):
    body = "#EXTM3U\n#EXT-X-TARGETDURATION:10\n" + "".join(f"#EXTINF:10,\nseg{i}.ts\n" for i in range(n))
    if not live:
        body += "#EXT-X-ENDLIST\n"
    open(f"qa/{name}", "w").write(body)
media("v1080.m3u8"); media("v720.m3u8"); media("audio.m3u8"); media("live.m3u8", live=True, n=6)
media("mixed_a.m3u8"); media("mixed_b.m3u8"); media("other.m3u8"); media("spa_a.m3u8", n=100); media("spa_b.m3u8", n=120)
open("qa/master_sep.m3u8", "w").write('''#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="en",DEFAULT=YES,URI="audio.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=3700000,RESOLUTION=1920x1080,AUDIO="aud"
v1080.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1800000,RESOLUTION=1280x720,AUDIO="aud"
v720.m3u8
''')
open("qa/master_mixed.m3u8", "w").write('''#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2"
mixed_a.m3u8?token=abc
#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=854x480,CODECS="avc1.4d401e,mp4a.40.2"
mixed_b.m3u8
''')
open("qa/garbage.m3u8", "w").write("<html>this is not a playlist</html>")
open("spa.html", "w", encoding="utf-8").write('''<!doctype html>
<meta charset="utf-8">
<title>SPA video A</title>
<script>
  // like YouTube: one page, the address changes without a reload and a new video starts
  fetch('qa/spa_a.m3u8').then(r => r.text());
  setTimeout(() => {
    history.pushState({}, '', '/spa.html?v=B');
    document.title = 'SPA video B';
    fetch('qa/spa_b.m3u8').then(r => r.text());
  }, 2500);
</script>
''')
open("qa.html", "w", encoding="utf-8").write('''<!doctype html>
<meta charset="utf-8">
<meta property="og:video:url" content="http://127.0.0.1:8791/embed/TdFBnN-M-5Y">
<title>Is QQQ Repeating 2018? 5 AI Stocks Showing Strength (Options With Ryan) ปาฏิหาริย์ข้ามกาลเวลา</title>
<h1>VDH QA page</h1>
<script>
  for (const f of ['master_sep', 'master_mixed', 'live', 'garbage']) fetch('qa/' + f + '.m3u8').then(r => r.text());
  // a variant requested with a different query string than the master lists
  fetch('qa/mixed_a.m3u8?token=zzz').then(r => r.text());
  // a rendition the master does not list by this address: same length as the master, same host
  fetch('qa/other.m3u8').then(r => r.text());
</script>
''')
PY

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
