// HLS engine. Runs in an offscreen document because the service worker cannot hold
// large blobs or run for long. Downloads segments, decrypts plain AES-128, joins
// them (transmuxing MPEG-TS to MP4 with mux.js) and hands back a blob URL.

import { parsePlaylist, ivFromSequence, hexToBytes } from './lib/hls.js';

const CONCURRENCY = 6;
const RETRIES = 3;
const controllers = new Map();
const keyCache = new Map();

const send = (msg) => chrome.runtime.sendMessage(msg).catch(() => {});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.target !== 'offscreen') return false;
  if (msg.type === 'hls-start') run(msg);
  else if (msg.type === 'hls-cancel') controllers.get(msg.jobId)?.abort();
  else if (msg.type === 'revoke') URL.revokeObjectURL(msg.url);
  return false;
});

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new DOMException('Aborted', 'AbortError'));
    });
  });
}

async function fetchRetry(url, { range, signal } = {}) {
  let lastErr;
  for (let attempt = 0; attempt < RETRIES; attempt++) {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    try {
      const headers = range ? { Range: `bytes=${range.start}-${range.start + range.length - 1}` } : {};
      const res = await fetch(url, { credentials: 'include', headers, signal });
      if (res.status === 401 || res.status === 403) throw Object.assign(new Error(`The server refused the request (${res.status})`), { fatal: true });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    } catch (e) {
      if (e.name === 'AbortError' || e.fatal) throw e;
      lastErr = e;
      await sleep(500 * 2 ** attempt, signal);
    }
  }
  throw lastErr;
}

async function getKey(uri, signal) {
  if (!keyCache.has(uri)) {
    keyCache.set(
      uri,
      fetchRetry(uri, { signal }).then((raw) => {
        if (raw.length !== 16) throw new Error('Unexpected encryption key format');
        return crypto.subtle.importKey('raw', raw, 'AES-CBC', false, ['decrypt']);
      }),
    );
  }
  return keyCache.get(uri);
}

async function decrypt(bytes, seg, signal) {
  if (!seg.key) return bytes;
  if (seg.key.method !== 'AES-128') throw new Error(`Unsupported encryption (${seg.key.method})`);
  const key = await getKey(seg.key.uri, signal);
  const iv = seg.key.iv ? hexToBytes(seg.key.iv) : ivFromSequence(seg.seq);
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, key, bytes));
}

async function fetchText(url, signal) {
  const res = await fetch(url, { credentials: 'include', signal });
  if (!res.ok) throw new Error(`Playlist request failed (HTTP ${res.status})`);
  return res.text();
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  promise.catch(() => {}); // avoid unhandled rejection noise; consumer awaits it
  return { promise, resolve, reject };
}

const fmtMB = (n) => `${(n / 1048576).toFixed(n > 1e8 ? 0 : 1)} MB`;

async function run(msg) {
  const { jobId } = msg;
  const ctl = new AbortController();
  controllers.set(jobId, ctl);
  const { signal } = ctl;
  try {
    let pl = parsePlaylist(await fetchText(msg.playlistUrl, signal), msg.playlistUrl);
    if (pl.isMaster) {
      const best = [...pl.variants].sort((a, b) => b.bandwidth - a.bandwidth)[0];
      if (!best) throw new Error('The playlist has no video streams.');
      pl = parsePlaylist(await fetchText(best.url, signal), best.url);
    }
    if (pl.protected) throw new Error(`This stream is protected (${pl.protected}). It cannot be downloaded.`);
    if (!pl.endlist) throw new Error('This is a live stream. Live streams need the helper app.');
    const segs = pl.segments;
    if (!segs.length) throw new Error('The playlist has no segments.');

    // Make sure referer rules exist for every host we are about to hit.
    const hosts = new Set();
    for (const s of segs) {
      hosts.add(new URL(s.url).hostname);
      if (s.key?.uri) hosts.add(new URL(s.key.uri).hostname);
      if (s.map) hosts.add(new URL(s.map.url).hostname);
    }
    await chrome.runtime.sendMessage({ type: 'hls-hosts', hosts: [...hosts], pageUrl: msg.pageUrl });

    // Download with limited parallelism; consume in order.
    const total = segs.length;
    const slots = segs.map(() => deferred());
    let next = 0;
    let fetchedBytes = 0;
    let completed = 0;
    let firstError = null;
    const initCache = new Map();

    const initFor = async (map) => {
      if (!map) return null;
      const k = `${map.url}|${map.range?.start ?? ''}`;
      if (!initCache.has(k)) initCache.set(k, fetchRetry(map.url, { range: map.range, signal }));
      return initCache.get(k);
    };

    const worker = async () => {
      while (!signal.aborted) {
        const i = next++;
        if (i >= total) return;
        try {
          const seg = segs[i];
          let bytes = await fetchRetry(seg.url, { range: seg.range, signal });
          bytes = await decrypt(bytes, seg, signal);
          fetchedBytes += bytes.length;
          if (fetchedBytes > msg.maxBytes) throw new Error('This video is too big to assemble in the browser (over 1.5 GB). Use the helper app.');
          completed++;
          send({ type: 'hls-progress', jobId, percent: Math.min(98, Math.round((completed / total) * 100)), detail: `${completed}/${total} segments · ${fmtMB(fetchedBytes)}` });
          slots[i].resolve(bytes);
        } catch (e) {
          if (!firstError && e.name !== 'AbortError') firstError = e;
          slots[i].reject(e);
          ctl.abort();
          return;
        }
      }
    };
    const workers = Array.from({ length: Math.min(CONCURRENCY, total) }, worker);

    const pieces = [];
    let mode = null; // 'mux' | 'ts' | 'raw'
    let tx = null;
    let initWritten = false;
    let hasVideo = false;
    let lastMap = null;

    const onData = (d) => {
      if (!initWritten) {
        pieces.push(d.initSegment);
        for (const t of d.tracks || []) if (t.type === 'video') hasVideo = true;
        initWritten = true;
      }
      pieces.push(d.data);
    };

    for (let i = 0; i < total; i++) {
      const seg = segs[i];
      let bytes;
      try {
        bytes = await slots[i].promise;
      } catch (e) {
        throw firstError || e;
      }

      if (seg.map && seg.map !== lastMap && seg.map.url !== lastMap?.url) {
        const init = await initFor(seg.map);
        if (init) pieces.push(init);
        lastMap = seg.map;
      }

      if (mode === null) {
        const isTs = bytes[0] === 0x47 && (bytes.length < 189 || bytes[188] === 0x47);
        if (!isTs || seg.map) {
          mode = 'raw';
        } else {
          tx = new muxjs.mp4.Transmuxer({ keepOriginalTimestamps: false });
          tx.on('data', onData);
          tx.push(bytes);
          tx.flush();
          mode = pieces.length ? 'mux' : 'ts';
          if (mode === 'ts') {
            tx.dispose();
            tx = null;
            pieces.length = 0;
            pieces.push(bytes);
          }
          continue;
        }
      }

      if (mode === 'mux') {
        tx.push(bytes);
        tx.flush();
      } else {
        pieces.push(bytes);
      }
      slots[i] = null;
    }
    await Promise.all(workers);
    if (tx) tx.dispose();

    const base = String(msg.name || 'video');
    let ext;
    let type;
    if (mode === 'mux') {
      ext = hasVideo ? 'mp4' : 'm4a';
      type = hasVideo ? 'video/mp4' : 'audio/mp4';
    } else if (mode === 'ts') {
      ext = 'ts';
      type = 'video/mp2t';
    } else {
      const looksAudio = /\.(aac|m4a|cmfa)(\?|$)/i.test(segs[0].url);
      ext = looksAudio ? 'm4a' : 'mp4';
      type = looksAudio ? 'audio/mp4' : 'video/mp4';
    }
    const blob = new Blob(pieces, { type });
    pieces.length = 0;
    const blobUrl = URL.createObjectURL(blob);
    send({ type: 'hls-done', jobId, blobUrl, filename: `${base}.${ext}`, bytes: blob.size });
  } catch (e) {
    send({ type: 'hls-error', jobId, message: e.name === 'AbortError' ? 'Canceled' : e.message || String(e) });
  } finally {
    controllers.delete(jobId);
  }
}
