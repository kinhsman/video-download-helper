// Minimal HLS playlist parser (master and media playlists). Pure JS, no DOM, so
// both the service worker and the offscreen document can import it.

const DRM_METHODS = new Set(['SAMPLE-AES', 'SAMPLE-AES-CTR', 'SAMPLE-AES-CENC']);

export function parseAttrs(str) {
  const attrs = {};
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let m;
  while ((m = re.exec(str))) {
    attrs[m[1]] = m[2].startsWith('"') ? m[2].slice(1, -1) : m[2];
  }
  return attrs;
}

function protectionReason(attrs) {
  const method = (attrs.METHOD || 'NONE').toUpperCase();
  if (method === 'NONE') return null;
  if (DRM_METHODS.has(method)) return `DRM (${method})`;
  const fmt = (attrs.KEYFORMAT || 'identity').toLowerCase();
  if (fmt !== 'identity') return `DRM (${fmt})`;
  return null;
}

function parseRange(value, lastEndByUri, uri) {
  const [len, off] = value.split('@');
  const length = parseInt(len, 10);
  const start = off !== undefined ? parseInt(off, 10) : (lastEndByUri.get(uri) ?? 0);
  lastEndByUri.set(uri, start + length);
  return { start, length };
}

export function parsePlaylist(text, baseUrl) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length || !lines[0].startsWith('#EXTM3U')) throw new Error('Not an HLS playlist');
  const abs = (u) => new URL(u, baseUrl).href;

  const out = {
    isMaster: false,
    variants: [],
    audio: [],
    segments: [],
    endlist: false,
    targetDuration: 0,
    mediaSequence: 0,
    duration: 0,
    protected: null,
    encrypted: false,
  };

  let key = null;
  let map = null;
  let pendingInf = null;
  let pendingRange = null;
  let pendingStream = null;
  let pendingDiscontinuity = false;
  const lastEndByUri = new Map();

  for (const line of lines) {
    if (line.startsWith('#')) {
      const colon = line.indexOf(':');
      const tag = colon === -1 ? line : line.slice(0, colon);
      const val = colon === -1 ? '' : line.slice(colon + 1);
      switch (tag) {
        case '#EXT-X-STREAM-INF': {
          out.isMaster = true;
          pendingStream = parseAttrs(val);
          break;
        }
        case '#EXT-X-MEDIA': {
          const a = parseAttrs(val);
          if (a.TYPE === 'AUDIO' && a.URI) {
            out.audio.push({ groupId: a['GROUP-ID'], uri: abs(a.URI), name: a.NAME, language: a.LANGUAGE, isDefault: a.DEFAULT === 'YES' });
          }
          break;
        }
        case '#EXT-X-SESSION-KEY':
        case '#EXT-X-KEY': {
          const a = parseAttrs(val);
          const reason = protectionReason(a);
          if (reason) out.protected = reason;
          if (tag === '#EXT-X-KEY') {
            if ((a.METHOD || 'NONE').toUpperCase() === 'NONE') {
              key = null;
            } else {
              key = { method: a.METHOD.toUpperCase(), uri: a.URI ? abs(a.URI) : null, iv: a.IV || null };
              out.encrypted = true;
            }
          }
          break;
        }
        case '#EXT-X-MAP': {
          const a = parseAttrs(val);
          map = { url: abs(a.URI), range: a.BYTERANGE ? parseRange(a.BYTERANGE, lastEndByUri, abs(a.URI)) : null };
          break;
        }
        case '#EXTINF':
          pendingInf = parseFloat(val) || 0;
          break;
        case '#EXT-X-BYTERANGE':
          pendingRange = val;
          break;
        case '#EXT-X-DISCONTINUITY':
          pendingDiscontinuity = true;
          break;
        case '#EXT-X-MEDIA-SEQUENCE':
          out.mediaSequence = parseInt(val, 10) || 0;
          break;
        case '#EXT-X-TARGETDURATION':
          out.targetDuration = parseInt(val, 10) || 0;
          break;
        case '#EXT-X-ENDLIST':
          out.endlist = true;
          break;
        default:
      }
      continue;
    }

    // URI line
    if (pendingStream) {
      const [w, h] = (pendingStream.RESOLUTION || '').split('x').map((n) => parseInt(n, 10));
      out.variants.push({
        url: abs(line),
        bandwidth: parseInt(pendingStream.BANDWIDTH, 10) || 0,
        resolution: pendingStream.RESOLUTION || null,
        width: w || 0,
        height: h || 0,
        codecs: pendingStream.CODECS || '',
        audioGroup: pendingStream.AUDIO || null,
        frameRate: pendingStream['FRAME-RATE'] ? parseFloat(pendingStream['FRAME-RATE']) : null,
      });
      pendingStream = null;
      continue;
    }

    if (pendingInf !== null) {
      const url = abs(line);
      out.segments.push({
        url,
        duration: pendingInf,
        seq: out.mediaSequence + out.segments.length,
        key,
        map,
        range: pendingRange ? parseRange(pendingRange, lastEndByUri, url) : null,
        discontinuity: pendingDiscontinuity,
      });
      out.duration += pendingInf;
      pendingInf = null;
      pendingRange = null;
      pendingDiscontinuity = false;
    }
  }

  return out;
}

export function variantLabel(v) {
  const parts = [];
  if (v.height) parts.push(`${v.height}p${v.frameRate && v.frameRate > 30 ? Math.round(v.frameRate) : ''}`);
  else if (v.codecs && !/avc|hvc|hev|vp0?9|av01/i.test(v.codecs)) parts.push('audio only');
  if (v.bandwidth) parts.push(`${(v.bandwidth / 1e6).toFixed(1)} Mbps`);
  return parts.join(' · ') || 'stream';
}

// Default IV for AES-128 when the playlist omits one: segment sequence number, big endian.
export function ivFromSequence(seq) {
  const iv = new Uint8Array(16);
  let n = BigInt(seq);
  for (let i = 15; i >= 0 && n > 0n; i--) {
    iv[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return iv;
}

export function hexToBytes(hex) {
  const h = hex.replace(/^0x/i, '').padStart(32, '0');
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// Some sites serve a plain HLS playlist from an address with no .m3u8 ending and a generic content type.
// These two checks let the extension spot those by looking at the first bytes, without touching anything protected.
const SNIFF_MIME = new Set(['', 'text/plain', 'application/octet-stream', 'binary/octet-stream']);
const SKIP_EXT = /\.(js|mjs|css|json|html?|xml|txt|map|png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|otf|ts|m4s|mp4|m4v|webm|mov|mkv|aac|vtt|srt)$/i;

export function shouldSniffForPlaylist(url, mime = '', size = 0) {
  let path;
  try {
    path = new URL(url).pathname;
  } catch {
    return false;
  }
  if (SKIP_EXT.test(path)) return false;
  if (!SNIFF_MIME.has(mime.split(';')[0].trim().toLowerCase())) return false;
  return !size || size <= 4e6;
}

export function looksLikePlaylist(text) {
  return /^﻿?\s*#EXTM3U/.test(text || '');
}
