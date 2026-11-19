// Unit tests for the HLS playlist parser: node tests/test_parser.mjs
import { parsePlaylist, ivFromSequence, variantLabel } from '../extension/lib/hls.js';

let failed = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : '  ' + extra}`);
  if (!ok) failed++;
};
const B = 'https://cdn.example.com/v/';

let p = parsePlaylist(`#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,CODECS="avc1.4d401e,mp4a.40.2",AUDIO="aud"
low/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2800000,RESOLUTION=1280x720,FRAME-RATE=59.94
https://other.example.com/hi.m3u8
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="en",URI="audio/en.m3u8"
`, B + 'master.m3u8');
check('master: variants resolved against base url', p.isMaster && p.variants[0].url === B + 'low/index.m3u8' && p.variants[1].url === 'https://other.example.com/hi.m3u8');
check('master: attributes parsed (quoted codecs with comma, resolution, fps)', p.variants[0].codecs === 'avc1.4d401e,mp4a.40.2' && p.variants[1].height === 720 && p.variants[1].frameRate > 59);
check('master: separate audio rendition found', p.audio.length === 1 && p.audio[0].uri === B + 'audio/en.m3u8');
check('variant label', variantLabel(p.variants[1]) === '720p60 · 2.8 Mbps', variantLabel(p.variants[1]));

p = parsePlaylist(`#EXTM3U
#EXT-X-TARGETDURATION:4
#EXT-X-MEDIA-SEQUENCE:7
#EXT-X-KEY:METHOD=AES-128,URI="k.key",IV=0x00000000000000000000000000000009
#EXTINF:4.0,
a.ts
#EXTINF:3.5,
b.ts
#EXT-X-ENDLIST
`, B + 'x/index.m3u8');
check('media: segments, durations, sequence', p.segments.length === 2 && p.duration === 7.5 && p.segments[1].seq === 8);
check('media: AES-128 key attached and not treated as DRM', p.encrypted && !p.protected && p.segments[0].key.uri === B + 'x/k.key');
check('media: endlist detected', p.endlist);

p = parsePlaylist(`#EXTM3U
#EXT-X-MAP:URI="init.mp4",BYTERANGE="720@0"
#EXTINF:4,
#EXT-X-BYTERANGE:1000@720
f.mp4
#EXTINF:4,
#EXT-X-BYTERANGE:500
f.mp4
`, B + 'i.m3u8');
check('fMP4: init map and byte ranges (implicit offset continues)', p.segments[0].map.url === B + 'init.mp4' && p.segments[0].range.start === 720 && p.segments[1].range.start === 1720 && p.segments[1].range.length === 500);
check('fMP4: no endlist means live', !p.endlist);

for (const [label, tag] of [
  ['SAMPLE-AES', '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://x",KEYFORMAT="com.apple.streamingkeydelivery"'],
  ['Widevine key format', '#EXT-X-KEY:METHOD=AES-128,URI="data:text/plain;base64,AAAA",KEYFORMAT="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"'],
  ['SAMPLE-AES-CTR', '#EXT-X-KEY:METHOD=SAMPLE-AES-CTR,URI="x"'],
]) {
  p = parsePlaylist(`#EXTM3U\n${tag}\n#EXTINF:4,\na.ts\n#EXT-X-ENDLIST\n`, B);
  check(`DRM flagged: ${label}`, !!p.protected, JSON.stringify(p.protected));
}

check('default IV is the sequence number', ivFromSequence(258).join(',') === '0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,2');
let threw = false;
try { parsePlaylist('<html>nope</html>', B); } catch { threw = true; }
check('rejects non-playlists', threw);

console.log(failed ? `\n${failed} failed` : '\nAll parser checks passed');
process.exit(failed ? 1 : 0);
