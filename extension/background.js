import { parsePlaylist, variantLabel } from './lib/hls.js';

const HELPER_HOST = 'com.sang.video_helper';
const MIN_FILE_BYTES = 1024 * 1024; // smaller network files are almost always stream chunks, thumbnails or ads
const DRM_HINT = /(^|[\/_.-])drm([\/_.-]|$)/i;
const SEGMENT_HINT = /(^|[\/_.-])(seg(ment)?|chunk|frag(ment)?|init|part)[-_]?\d*\.(mp4|m4s|m4v|webm|pmp4)$|\/\d+\.(mp4|m4v|webm|pmp4|m4s)$/i;
const MAX_BROWSER_HLS_BYTES = 1.5 * 1024 * 1024 * 1024;
const SAVE_DIR = 'VideoHelper';

// ---------- state ----------

const tabItems = new Map(); // tabId -> Map(key -> item)
const tabPageKey = new Map(); // tabId -> which page (or YouTube video) the tab is on right now
const jobs = new Map(); // jobId -> job
const helperPorts = new Map(); // jobId -> native port
let saveJobsTimer = null;

const ready = (async () => {
  const all = await chrome.storage.session.get(null);
  for (const [k, v] of Object.entries(all)) {
    if (k.startsWith('items:')) {
      tabItems.set(Number(k.slice(6)), new Map(v.map((i) => [i.key, i])));
    } else if (k === 'jobs') {
      for (const j of v) jobs.set(j.id, j);
    }
  }
})();

function persistTab(tabId) {
  const items = tabItems.get(tabId);
  const key = `items:${tabId}`;
  if (!items || !items.size) return chrome.storage.session.remove(key);
  return chrome.storage.session.set({ [key]: [...items.values()] });
}

function saveJobsSoon(immediate = false) {
  if (immediate) {
    clearTimeout(saveJobsTimer);
    saveJobsTimer = null;
    return chrome.storage.session.set({ jobs: [...jobs.values()].slice(-30) });
  }
  if (saveJobsTimer) return;
  saveJobsTimer = setTimeout(() => {
    saveJobsTimer = null;
    chrome.storage.session.set({ jobs: [...jobs.values()].slice(-30) });
  }, 200);
}

function updateJob(id, patch, immediate = true) {
  const job = jobs.get(id);
  if (!job) return null;
  Object.assign(job, patch);
  saveJobsSoon(immediate);
  return job;
}

function newJob(fields) {
  const job = {
    id: `j${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    status: 'running',
    percent: 0,
    detail: 'Starting',
    startedAt: Date.now(),
    ...fields,
  };
  jobs.set(job.id, job);
  saveJobsSoon(true);
  return job;
}

// ---------- helpers ----------

// Single page apps (YouTube) change the address without loading a new page, so the video is part of the key.
function pageKeyOf(url) {
  try {
    const u = new URL(url);
    const v = u.searchParams.get('v');
    return u.origin + u.pathname + (v ? `?v=${v}` : '');
  } catch {
    return '';
  }
}

function hash(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
}

function classify(url, mime = '') {
  let path;
  try {
    path = new URL(url).pathname.toLowerCase();
  } catch {
    return null;
  }
  const m = mime.split(';')[0].trim().toLowerCase();
  if (/\.m3u8$/.test(path) || ['application/vnd.apple.mpegurl', 'application/x-mpegurl', 'audio/mpegurl', 'audio/x-mpegurl'].includes(m)) return 'hls';
  if (/\.mpd$/.test(path) || m === 'application/dash+xml') return 'dash';
  if (/\.(ts|m4s|aac|cmfv|cmfa|vtt|srt)$/.test(path) || m === 'video/mp2t' || m === 'video/iso.segment') return null;
  if (m.startsWith('video/') || /\.(mp4|m4v|webm|mov|mkv|ogv|flv)$/.test(path)) return 'file';
  return null;
}

function safeName(title, fallback = 'video') {
  const s = (title || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 100)
    .trim();
  return s || fallback;
}

function fileExt(url, mime = '') {
  try {
    const m = new URL(url).pathname.toLowerCase().match(/\.(mp4|m4v|webm|mov|mkv|ogv|flv)$/);
    if (m) return m[1];
  } catch {}
  const t = mime.split(';')[0].toLowerCase();
  if (t.includes('webm')) return 'webm';
  if (t.includes('quicktime')) return 'mov';
  return 'mp4';
}

function isHttp(url) {
  return /^https?:\/\//i.test(url || '');
}

// Make requests made by the extension itself look like they came from the page,
// so hotlink-protected servers hand over the video.
async function ensureRefererRules(hosts, pageUrl) {
  if (!isHttp(pageUrl)) return;
  let origin;
  try {
    origin = new URL(pageUrl).origin;
  } catch {
    return;
  }
  const addRules = [];
  const removeRuleIds = [];
  for (const host of new Set(hosts)) {
    if (!host) continue;
    const id = 1 + (parseInt(hash(host), 16) % 90000);
    removeRuleIds.push(id);
    addRules.push({
      id,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [
          { header: 'referer', operation: 'set', value: pageUrl },
          { header: 'origin', operation: 'set', value: origin },
        ],
      },
      condition: {
        requestDomains: [host],
        tabIds: [chrome.tabs.TAB_ID_NONE],
        resourceTypes: ['xmlhttprequest', 'media', 'other'],
      },
    });
  }
  if (addRules.length) await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds, addRules });
}

const hostOf = (url) => {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
};

// ---------- detection ----------

async function addItem(tabId, info) {
  await ready;
  if (tabId < 0) return null;
  const key = hash(info.url.split('#')[0]);
  let items = tabItems.get(tabId);
  if (!items) {
    items = new Map();
    tabItems.set(tabId, items);
  }
  const existing = items.get(key);
  if (existing) {
    if (info.size && !existing.size) {
      existing.size = info.size;
      await persistTab(tabId);
    }
    return existing;
  }
  let tab = null;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {}
  const item = {
    key,
    url: info.url,
    kind: info.kind,
    mime: info.mime || '',
    size: info.size || 0,
    referer: info.referer || tab?.url || '',
    pageUrl: tab?.url || '',
    title: tab?.title || '',
    time: Date.now(),
    source: info.source || 'network',
    pageKey: pageKeyOf(tab?.url),
    hls: null,
  };
  if (item.pageKey) tabPageKey.set(tabId, item.pageKey);
  if (items.size >= 60) items.delete(items.keys().next().value);
  items.set(key, item);
  await persistTab(tabId);
  updateBadge(tabId);
  if (item.kind === 'hls') probeHls(tabId, item);
  if (item.kind === 'dash') probeDash(tabId, item);
  return item;
}

async function fetchPlaylist(url, referer) {
  await ensureRefererRules([hostOf(url)], referer);
  const res = await fetch(url, { credentials: 'include', signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  if (text.length > 4e6) throw new Error('Playlist too large');
  return parsePlaylist(text, url);
}

async function probeHls(tabId, item) {
  try {
    let pl = await fetchPlaylist(item.url, item.referer);
    const hls = { isMaster: pl.isMaster, variants: [], audio: pl.audio, duration: 0, live: false, protected: pl.protected, error: null };
    if (pl.isMaster) {
      const sorted = [...pl.variants].sort((a, b) => b.bandwidth - a.bandwidth);
      hls.variants = sorted.map((v) => ({ url: v.url, label: variantLabel(v), height: v.height, bandwidth: v.bandwidth, audioGroup: v.audioGroup }));
      if (sorted[0]) {
        try {
          const media = await fetchPlaylist(sorted[0].url, item.referer);
          hls.duration = media.duration;
          hls.live = !media.endlist;
          hls.protected = hls.protected || media.protected;
        } catch (e) {
          hls.error = `Could not read variant playlist: ${e.message}`;
        }
      }
    } else {
      hls.duration = pl.duration;
      hls.live = !pl.endlist;
    }
    for (const v of hls.variants) v.estBytes = hls.duration && v.bandwidth ? (v.bandwidth * hls.duration) / 8 : 0;
    // A variant that needs a separate audio rendition (audio group with its own URI).
    for (const v of hls.variants) v.separateAudio = !!(v.audioGroup && hls.audio.some((a) => a.groupId === v.audioGroup));
    item.hls = hls;
  } catch (e) {
    item.hls = { isMaster: false, variants: [], audio: [], duration: 0, live: false, protected: null, error: e.message };
  }
  await ready;
  await persistTab(tabId);
  updateBadge(tabId);
}

const normUrl = (u) => {
  try {
    const x = new URL(u);
    return x.origin + x.pathname;
  } catch {
    return u;
  }
};

// Reads a DASH manifest just enough to know whether it is copy-protected and which files it points at.
async function probeDash(tabId, item) {
  try {
    await ensureRefererRules([hostOf(item.url)], item.referer);
    const res = await fetch(item.url, { credentials: 'include', signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = (await res.text()).slice(0, 4e6);
    let reason = null;
    const cps = text.match(/<ContentProtection\b[^>]*>/gi) || [];
    for (const tag of cps) {
      if (/edef8ba9-79d6-4ace-a3c8-27dcd51d21ed/i.test(tag)) reason = 'DRM (Widevine)';
      else if (/9a04f079-9840-4286-ab92-e65be0885f95|playready/i.test(tag)) reason = reason || 'DRM (PlayReady)';
      else if (/94ce86fb-07ff-4f43-adb8-93d2fa968ca2|fairplay/i.test(tag)) reason = reason || 'DRM (FairPlay)';
    }
    if (!reason && cps.some((t) => /mp4protection|cenc|cbcs/i.test(t))) reason = 'DRM (encrypted)';
    const tracks = [];
    for (const m of text.matchAll(/<BaseURL[^>]*>\s*([^<\s]+)\s*<\/BaseURL>/gi)) {
      try {
        tracks.push(normUrl(new URL(m[1], item.url).href));
      } catch {}
    }
    let duration = 0;
    const dm = text.match(/mediaPresentationDuration="P(?:(\d+)D)?T?(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?"/i);
    if (dm) duration = (+dm[1] || 0) * 86400 + (+dm[2] || 0) * 3600 + (+dm[3] || 0) * 60 + (+dm[4] || 0);
    item.dash = { protected: reason, tracks, duration, error: null };
  } catch (e) {
    item.dash = { protected: null, tracks: [], duration: 0, error: e.message };
  }
  await ready;
  await persistTab(tabId);
  updateBadge(tabId);
}

function protectedReasonOf(it) {
  if (it.hls?.protected) return it.hls.protected;
  if (it.dash?.protected) return it.dash.protected;
  if (it.kind === 'file') {
    try {
      if (DRM_HINT.test(new URL(it.url).pathname)) return 'DRM (stream name says drm)';
    } catch {}
  }
  return null;
}

function visibleItems(tabId) {
  // Items found on an earlier video of the same tab (YouTube keeps one page) are not this video's.
  const here = tabPageKey.get(tabId);
  const items = [...(tabItems.get(tabId)?.values() || [])].filter((it) => !here || !it.pageKey || it.pageKey === here);
  const hidden = new Set();
  for (const it of items) {
    if (it.hls?.isMaster) {
      for (const v of it.hls.variants) hidden.add(normUrl(v.url));
      for (const a of it.hls.audio) hidden.add(normUrl(a.uri));
    }
  }
  // Picture and sound files that belong to a DASH manifest are parts of one stream, show only the manifest.
  const dashTracks = new Set(items.flatMap((it) => it.dash?.tracks || []));
  return items
    .filter((it) => !hidden.has(normUrl(it.url)))
    .filter((it) => !(it.kind === 'file' && dashTracks.has(normUrl(it.url))))
    .filter((it) => !(it.kind === 'file' && it.source !== 'dom' && isSegmentLike(it)))
    .sort((a, b) => b.time - a.time);
}

// Chunks of a streamed video that happen to be served as .mp4 files.
function isSegmentLike(it) {
  try {
    if (SEGMENT_HINT.test(new URL(it.url).pathname)) return true;
  } catch {}
  return it.size > 0 && it.size < MIN_FILE_BYTES;
}

// Marks previews, ads and short clips so the popup can hide them and keep the real video in front.
const MINOR_MAX_SECONDS = 60;
const MAIN_MIN_SECONDS = 180;
const MAIN_MIN_BYTES = 20 * 1024 * 1024;
const MINOR_SIZE_RATIO = 0.1;

function annotate(items) {
  const dur = (it) => it.hls?.duration || it.dash?.duration || 0;
  // Another playlist on the same host with the same length as a master playlist is probably one of its
  // renditions. It is tucked away with the other minor items, not deleted, in case it is a real video.
  const masters = items.filter((it) => it.hls?.isMaster && it.hls.duration > 0);
  const looksLikeRendition = (it) =>
    it.kind === 'hls' && it.hls && !it.hls.isMaster && it.hls.duration > 0 &&
    masters.some((m) => hostOf(m.url) === hostOf(it.url) && Math.abs(m.hls.duration - it.hls.duration) < 2);
  const longest = Math.max(0, ...items.map(dur));
  const maxFile = Math.max(0, ...items.filter((i) => i.kind === 'file').map((i) => i.size || 0));
  return items.map((it) => {
    const d = dur(it);
    let minor = null;
    if (looksLikeRendition(it)) minor = 'looks like part of another stream';
    else if (d > 0 && d < MINOR_MAX_SECONDS && longest >= MAIN_MIN_SECONDS) minor = 'short clip';
    else if (it.kind === 'file' && it.size > 0 && maxFile >= MAIN_MIN_BYTES && it.size < maxFile * MINOR_SIZE_RATIO) minor = 'much smaller than the main video';
    const needsHelper = it.kind === 'dash' || !!it.hls?.live || !!(it.hls?.variants?.length && it.hls.variants.every((v) => v.separateAudio));
    return { ...it, protectedReason: protectedReasonOf(it), minor, needsHelper };
  });
}

function updateBadge(tabId) {
  const n = annotate(visibleItems(tabId)).filter((i) => !i.minor).length;
  chrome.action.setBadgeText({ tabId, text: n ? String(n) : '' }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ tabId, color: '#2563eb' }).catch(() => {});
}

chrome.webRequest.onHeadersReceived.addListener(
  (d) => {
    if (d.tabId < 0 || d.statusCode >= 400) return;
    const h = (name) => d.responseHeaders?.find((x) => x.name.toLowerCase() === name)?.value || '';
    const mime = h('content-type');
    const kind = classify(d.url, mime);
    if (!kind) return;
    let size = parseInt(h('content-length'), 10) || 0;
    const range = h('content-range').match(/\/(\d+)$/);
    if (range) size = parseInt(range[1], 10);
    if (kind === 'file' && size && size < MIN_FILE_BYTES) return;
    addItem(d.tabId, { url: d.url, kind, mime, size, referer: d.documentUrl || d.initiator || '' });
  },
  { urls: ['<all_urls>'], types: ['media', 'xmlhttprequest', 'other'] },
  ['responseHeaders'],
);

chrome.webNavigation.onHistoryStateUpdated.addListener((d) => {
  if (d.frameId !== 0) return;
  tabPageKey.set(d.tabId, pageKeyOf(d.url));
  updateBadge(d.tabId);
});

chrome.webNavigation.onCommitted.addListener(async (d) => {
  if (d.frameId !== 0) return;
  tabPageKey.set(d.tabId, pageKeyOf(d.url));
  await ready;
  tabItems.delete(d.tabId);
  await persistTab(d.tabId);
  updateBadge(d.tabId);
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  tabPageKey.delete(tabId);
  await ready;
  tabItems.delete(tabId);
  chrome.storage.session.remove(`items:${tabId}`);
});

// ---------- downloads ----------

async function currentTitle(tabId, fallback) {
  try {
    return (await chrome.tabs.get(tabId)).title || fallback;
  } catch {
    return fallback;
  }
}

async function helperState() {
  const granted = await chrome.permissions.contains({ permissions: ['nativeMessaging'] });
  if (!granted) return { state: 'no-permission' };
  try {
    const reply = await helperRequest({ cmd: 'ping' }, 4000);
    return { state: 'ok', ...reply };
  } catch (e) {
    return { state: 'missing', error: e.message };
  }
}

function helperRequest(msg, timeoutMs) {
  return new Promise((resolve, reject) => {
    const port = chrome.runtime.connectNative(HELPER_HOST);
    const timer = setTimeout(() => {
      port.disconnect();
      reject(new Error('Helper did not answer'));
    }, timeoutMs);
    port.onMessage.addListener((m) => {
      clearTimeout(timer);
      port.disconnect();
      resolve(m);
    });
    port.onDisconnect.addListener(() => {
      clearTimeout(timer);
      reject(new Error(chrome.runtime.lastError?.message || 'Helper disconnected'));
    });
    port.postMessage(msg);
  });
}

// Update now: the helper swaps the files, installs missing tools and refreshes yt-dlp, telling us what it does
// as it goes. We reload ourselves at the end so it works even if the popup was closed meanwhile.
function applyUpdate() {
  return new Promise((resolve, reject) => {
    chrome.storage.session.set({ updateProgress: 'Starting update' });
    const port = chrome.runtime.connectNative(HELPER_HOST);
    let finished = false;
    const timer = setTimeout(() => {
      finished = true;
      port.disconnect();
      reject(new Error('The update took too long. Try again.'));
    }, 10 * 60 * 1000);
    port.onMessage.addListener((m) => {
      if (m.type === 'progress' && m.note) {
        chrome.storage.session.set({ updateProgress: m.note });
      } else if (m.type === 'updated') {
        finished = true;
        clearTimeout(timer);
        port.disconnect();
        chrome.storage.session.set({ updateProgress: `Updated to ${m.version}. Reloading` });
        notify('Video Download Helper updated', [`Now version ${m.version}.`, ...(m.notes || [])].join(' '));
        setTimeout(() => chrome.runtime.reload(), 1200);
        resolve({ version: m.version, notes: m.notes || [] });
      } else if (m.type === 'error') {
        finished = true;
        clearTimeout(timer);
        port.disconnect();
        reject(new Error(m.message));
      }
    });
    port.onDisconnect.addListener(() => {
      clearTimeout(timer);
      if (!finished) reject(new Error(chrome.runtime.lastError?.message || 'The helper closed during the update.'));
    });
    port.postMessage({ cmd: 'update' });
  });
}

function finishJob(id, patch) {
  const job = updateJob(id, { percent: 100, ...patch, status: 'done', finishedAt: Date.now() });
  if (!job) return;
  addHistory(job);
  notify(`Saved: ${job.title}`, job.filename || '');
}

function failJob(id, message) {
  const job = jobs.get(id);
  if (!job || job.status !== 'running') return;
  updateJob(id, { status: 'error', detail: message, finishedAt: Date.now() });
  addHistory(jobs.get(id));
  notify(`Failed: ${job.title}`, message);
}

async function addHistory(job) {
  const { history = [] } = await chrome.storage.local.get('history');
  history.unshift({ id: job.id, title: job.title, status: job.status, detail: job.detail, filename: job.filename || '', via: job.via, time: Date.now() });
  await chrome.storage.local.set({ history: history.slice(0, 50) });
}

function notify(title, message) {
  chrome.notifications.create('', { type: 'basic', iconUrl: 'icons/icon128.png', title, message: message || ' ' });
}

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['BLOBS'],
    justification: 'Assemble downloaded HLS video segments into a single file.',
  });
}

async function closeOffscreenIfIdle() {
  const busy = [...jobs.values()].some((j) => j.status === 'running' && j.via === 'browser-hls');
  if (!busy && (await chrome.offscreen.hasDocument())) await chrome.offscreen.closeDocument();
}

async function startDirect(item, title) {
  const name = `${safeName(title)}.${fileExt(item.url, item.mime)}`;
  const job = newJob({ title: safeName(title), itemKey: item.key, via: 'browser', kind: 'file', filename: name, detail: 'Downloading' });
  try {
    await ensureRefererRules([hostOf(item.url)], item.referer || item.pageUrl);
    const downloadId = await chrome.downloads.download({ url: item.url, filename: `${SAVE_DIR}/${name}`, conflictAction: 'uniquify', saveAs: false });
    updateJob(job.id, { downloadId });
  } catch (e) {
    failJob(job.id, e.message);
  }
  return job;
}

async function startHls(item, title, variantUrl) {
  const job = newJob({ title: safeName(title), itemKey: item.key, via: 'browser-hls', kind: 'hls', detail: 'Reading playlist' });
  try {
    await ensureRefererRules([hostOf(variantUrl || item.url)], item.referer || item.pageUrl);
    await ensureOffscreen();
    await chrome.runtime.sendMessage({
      target: 'offscreen',
      type: 'hls-start',
      jobId: job.id,
      playlistUrl: variantUrl || item.url,
      pageUrl: item.referer || item.pageUrl,
      name: safeName(title),
      maxBytes: MAX_BROWSER_HLS_BYTES,
    });
  } catch (e) {
    failJob(job.id, e.message);
  }
  return job;
}

function startHelper({ url, referer, title, quality, cookies, itemKey, named, subs }) {
  const job = newJob({ title: safeName(title), itemKey, via: 'helper', kind: 'helper', detail: 'Starting helper' });
  let port;
  try {
    port = chrome.runtime.connectNative(HELPER_HOST);
  } catch (e) {
    failJob(job.id, e.message);
    return job;
  }
  helperPorts.set(job.id, port);
  port.onMessage.addListener((m) => {
    if (m.type === 'progress') {
      const detail = m.note || [m.speed, m.eta && `ETA ${m.eta}`].filter(Boolean).join(' · ') || 'Downloading';
      updateJob(job.id, { percent: m.percent ?? jobs.get(job.id)?.percent ?? 0, detail }, false);
    } else if (m.type === 'done') {
      const bits = [m.existed ? 'Already saved earlier' : 'Saved'];
      if (m.subs?.length) bits.push(`${m.subs.length} subtitle file${m.subs.length > 1 ? 's' : ''}`);
      if (m.notes?.length) bits.push(...m.notes);
      finishJob(job.id, { filename: m.path, detail: bits.join(' · ') });
      helperPorts.delete(job.id);
      port.disconnect();
    } else if (m.type === 'error') {
      failJob(job.id, m.message);
      helperPorts.delete(job.id);
      port.disconnect();
    }
  });
  port.onDisconnect.addListener(() => {
    helperPorts.delete(job.id);
    failJob(job.id, chrome.runtime.lastError?.message || 'Helper closed unexpectedly');
  });
  port.postMessage({ cmd: 'download', id: job.id, url, referer, quality, cookies: !!cookies, title, named: !!named, subs });
  return job;
}

// YouTube's stream addresses are signed and expire quickly, and carry no subtitle information.
// yt-dlp does far better with the page address, so use that for Google's video hosts.
function helperUrlFor(item) {
  return /(^|\.)googlevideo\.com$/i.test(hostOf(item.url)) && isHttp(item.pageUrl) ? item.pageUrl : item.url;
}

async function startDownload({ tabId, itemKey, variantUrl, quality, cookies, subs }) {
  await ready;
  const item = tabItems.get(tabId)?.get(itemKey);
  if (!item) throw new Error('That video is no longer in the list. Press Force detect.');
  const title = await currentTitle(tabId, item.title);

  const locked = protectedReasonOf(item);
  if (locked) throw new Error(`This video is copy-protected (${locked}). This tool does not bypass copy protection.`);

  if (item.kind === 'file') return startDirect(item, title);

  if (item.kind === 'hls') {
    const hls = item.hls;
    if (hls?.protected) throw new Error(`This stream is protected (${hls.protected}). It cannot be downloaded.`);
    const variant = hls?.variants.find((v) => v.url === variantUrl);
    const needsHelper = hls?.live || variant?.separateAudio;
    if (needsHelper) {
      const hs = await helperState();
      if (hs.state === 'ok') return startHelper({ url: helperUrlFor(item), referer: item.referer, title, quality: quality || 'best', cookies, itemKey, named: true, subs });
      throw new Error(hls.live ? 'Live streams need the helper app, which is not set up.' : 'This quality keeps audio in a separate file, which needs the helper app. Pick another quality or set up the helper.');
    }
    return startHls(item, title, variantUrl);
  }

  // dash
  const hs = await helperState();
  if (hs.state !== 'ok') throw new Error('DASH streams need the helper app, which is not set up.');
  return startHelper({ url: helperUrlFor(item), referer: item.referer, title, quality: quality || 'best', cookies, itemKey, named: true, subs });
}

async function startPageDownload({ tabId, quality, cookies, subs }) {
  const tab = await chrome.tabs.get(tabId);
  if (!isHttp(tab.url)) throw new Error('This page cannot be downloaded.');
  await ready;
  const locked = [...(tabItems.get(tabId)?.values() || [])].map(protectedReasonOf).find(Boolean);
  if (locked) throw new Error(`The video on this page is copy-protected (${locked}). This tool does not bypass copy protection.`);
  const hs = await helperState();
  if (hs.state !== 'ok') throw new Error('The helper app is not set up.');
  return startHelper({ url: tab.url, referer: tab.url, title: tab.title, quality: quality || 'best', cookies, itemKey: 'page', subs });
}

async function cancelJob(id) {
  const job = jobs.get(id);
  if (!job || job.status !== 'running') return;
  if (job.downloadId) chrome.downloads.cancel(job.downloadId).catch(() => {});
  if (job.via === 'browser-hls') chrome.runtime.sendMessage({ target: 'offscreen', type: 'hls-cancel', jobId: id }).catch(() => {});
  const port = helperPorts.get(id);
  if (port) {
    port.postMessage({ cmd: 'cancel', id });
    helperPorts.delete(id);
    port.disconnect();
  }
  updateJob(id, { status: 'canceled', detail: 'Canceled', finishedAt: Date.now() });
  closeOffscreenIfIdle();
}

chrome.downloads.onChanged.addListener(async (delta) => {
  await ready;
  const job = [...jobs.values()].find((j) => j.downloadId === delta.id);
  if (!job || job.status !== 'running') return;
  if (delta.state?.current === 'complete') {
    const [d] = await chrome.downloads.search({ id: delta.id });
    finishJob(job.id, { filename: d?.filename || job.filename, detail: 'Saved' });
    if (job.blobUrl) chrome.runtime.sendMessage({ target: 'offscreen', type: 'revoke', url: job.blobUrl }).catch(() => {});
    closeOffscreenIfIdle();
  } else if (delta.state?.current === 'interrupted' || delta.error) {
    const code = delta.error?.current || 'unknown';
    const friendly = { SERVER_FORBIDDEN: 'The server refused the download (403)', SERVER_BAD_CONTENT: 'The server has no such file (404)', USER_CANCELED: 'Canceled' }[code] || `Download failed (${code})`;
    if (code === 'USER_CANCELED') updateJob(job.id, { status: 'canceled', detail: friendly });
    else failJob(job.id, friendly);
    closeOffscreenIfIdle();
  }
});

// ---------- messages ----------

async function handle(msg, sender) {
  await ready;
  switch (msg.type) {
    // from content script
    case 'dom-video': {
      const tabId = sender.tab?.id;
      if (tabId === undefined || !isHttp(msg.url)) return;
      const known = classify(msg.url, msg.mime);
      // og:video usually points at an embed web page (YouTube does), not at a video file. Only keep it when it looks like media.
      if (msg.fromMeta && !known) return;
      const kind = known || 'file';
      await addItem(tabId, { url: msg.url, kind, mime: msg.mime, size: 0, referer: msg.frameUrl, source: 'dom' });
      return;
    }

    // from offscreen document
    case 'hls-hosts':
      await ensureRefererRules(msg.hosts, msg.pageUrl);
      return { ok: true };
    case 'hls-progress':
      updateJob(msg.jobId, { percent: msg.percent, detail: msg.detail }, false);
      return;
    case 'hls-error':
      failJob(msg.jobId, msg.message);
      closeOffscreenIfIdle();
      return;
    case 'hls-done': {
      const job = jobs.get(msg.jobId);
      if (!job || job.status !== 'running') {
        chrome.runtime.sendMessage({ target: 'offscreen', type: 'revoke', url: msg.blobUrl }).catch(() => {});
        return;
      }
      updateJob(msg.jobId, { detail: 'Saving file', percent: 99, filename: msg.filename, blobUrl: msg.blobUrl });
      try {
        const downloadId = await chrome.downloads.download({ url: msg.blobUrl, filename: `${SAVE_DIR}/${msg.filename}`, conflictAction: 'uniquify', saveAs: false });
        updateJob(msg.jobId, { downloadId });
      } catch (e) {
        failJob(msg.jobId, e.message);
        closeOffscreenIfIdle();
      }
      return;
    }

    // from popup
    case 'list': {
      try {
        tabPageKey.set(msg.tabId, pageKeyOf((await chrome.tabs.get(msg.tabId)).url));
      } catch {}
      const items = annotate(visibleItems(msg.tabId));
      const main = items.filter((it) => !it.minor);
      // Sites that stream with DASH keep picture and sound in separate files.
      return { items, streamSite: main.some((it) => it.needsHelper), protectedSite: main.some((it) => it.protectedReason) };
    }
    case 'helper-state':
      return helperState();
    case 'update-state': {
      const { update } = await chrome.storage.local.get('update');
      const current = chrome.runtime.getManifest().version;
      // The stored answer may be from before this copy was updated, so judge it against the version running now.
      return update ? { ...update, current, available: !!update.latest && isNewer(update.latest, current) } : { current, available: false };
    }
    case 'check-update':
      return checkForUpdate();
    case 'apply-update':
      return applyUpdate();
    case 'download':
      return { job: await startDownload(msg) };
    case 'download-page':
      return { job: await startPageDownload(msg) };
    case 'cancel':
      await cancelJob(msg.jobId);
      return { ok: true };
    case 'reveal': {
      const job = jobs.get(msg.jobId);
      if (!job?.filename) throw new Error('No file recorded for that download.');
      if (job.downloadId) {
        const [d] = await chrome.downloads.search({ id: job.downloadId });
        if (!d?.exists) throw new Error('That file was moved or deleted.');
        chrome.downloads.show(job.downloadId);
        return { ok: true };
      }
      const r = await helperRequest({ cmd: 'reveal', path: job.filename }, 5000);
      if (r.type === 'error') throw new Error(r.message);
      return { ok: true };
    }
    case 'force-detect':
      await chrome.tabs.reload(msg.tabId, { bypassCache: true });
      return { ok: true };
    case 'clear-jobs':
      for (const [id, j] of jobs) if (j.status !== 'running') jobs.delete(id);
      await saveJobsSoon(true);
      return { ok: true };
    case 'clear-history':
      await chrome.storage.local.set({ history: [] });
      return { ok: true };
    default:
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target === 'offscreen') return false;
  handle(msg, sender).then(sendResponse, (e) => sendResponse({ error: e.message || String(e) }));
  return true;
});

// ---------- update check ----------
// The extension is loaded unpacked, so Chrome cannot update it. Once a day we compare our version with the
// published one. Applying the update is done by the helper app (it swaps the files), then the popup reloads us.

const UPDATE_ALARM = 'vdh-update-check';

function isNewer(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0;
  }
  return false;
}

async function fetchJson(url, headers = {}) {
  const res = await fetch(url, { cache: 'no-store', headers, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// The GitHub API answers within about a minute of a release. raw.githubusercontent.com can lag by 5 minutes and
// ignores query strings, so it is only the fallback (the API allows 60 requests an hour per address).
async function fetchPublishedVersion(cfg, override) {
  if (override) return fetchJson(override);
  try {
    return await fetchJson(`https://api.github.com/repos/${cfg.repo}/contents/version.json?ref=${encodeURIComponent(cfg.branch)}`, { Accept: 'application/vnd.github.raw' });
  } catch {
    return fetchJson(`https://raw.githubusercontent.com/${cfg.repo}/${cfg.branch}/version.json`);
  }
}

async function checkForUpdate() {
  const current = chrome.runtime.getManifest().version;
  const cfg = await (await fetch(chrome.runtime.getURL('repo.json'))).json();
  const { updateUrlOverride, update: prev } = await chrome.storage.local.get(['updateUrlOverride', 'update']);
  let state;
  try {
    const data = await fetchPublishedVersion(cfg, updateUrlOverride);
    if (!/^\d+(\.\d+){0,2}$/.test(String(data.version))) throw new Error('Unexpected version format');
    state = { current, latest: data.version, notes: String(data.notes || '').slice(0, 300), available: isNewer(data.version, current), checkedAt: Date.now(), error: null, repo: cfg.repo, branch: cfg.branch };
  } catch (e) {
    // A failed check must not hide an update we already knew about.
    const known = prev?.latest && isNewer(prev.latest, current);
    state = { current, latest: known ? prev.latest : current, notes: known ? prev.notes : '', available: !!known, checkedAt: Date.now(), error: e.message, repo: cfg.repo, branch: cfg.branch };
  }
  await chrome.storage.local.set({ update: state });
  if (state.available) {
    const { notifiedVersion } = await chrome.storage.local.get('notifiedVersion');
    if (notifiedVersion !== state.latest) {
      await chrome.storage.local.set({ notifiedVersion: state.latest });
      notify('Video Download Helper update', `Version ${state.latest} is available. Open the extension popup to update.`);
    }
  }
  return state;
}

function scheduleUpdateChecks() {
  chrome.alarms.create(UPDATE_ALARM, { delayInMinutes: 1, periodInMinutes: 720 });
}
chrome.runtime.onInstalled.addListener(() => {
  scheduleUpdateChecks();
  checkForUpdate().catch(() => {});
});
chrome.runtime.onStartup.addListener(scheduleUpdateChecks);
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === UPDATE_ALARM) checkForUpdate();
});

// ---------- context menu ----------

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'vdh-video', title: 'Download this video', contexts: ['video'] });
    chrome.contextMenus.create({ id: 'vdh-page', title: 'Download this page with yt-dlp (helper)', contexts: ['page'] });
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  await ready;
  try {
    if (info.menuItemId === 'vdh-page') {
      await startPageDownload({ tabId: tab.id, quality: 'best' });
      return;
    }
    // Right-clicked video: use its URL when it is a normal address, otherwise the biggest detected item.
    let item = null;
    if (isHttp(info.srcUrl)) {
      item = await addItem(tab.id, { url: info.srcUrl, kind: classify(info.srcUrl) || 'file', size: 0, referer: info.frameUrl || tab.url, source: 'dom' });
    } else {
      const list = visibleItems(tab.id);
      item = list.sort((a, b) => (b.size || 0) - (a.size || 0))[0];
    }
    if (!item) throw new Error('No downloadable video found on this page yet. Press play, then try again.');
    const variants = item.hls?.variants;
    await startDownload({ tabId: tab.id, itemKey: item.key, variantUrl: variants?.[0]?.url });
  } catch (e) {
    notify('Video Download Helper', e.message);
  }
});
