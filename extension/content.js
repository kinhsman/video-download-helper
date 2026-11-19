// Reports video URLs that are visible in the page's DOM but may not show up as
// network requests (og:video tags, <video src>, <source> children).

const seen = new Set();
const MAX_URLS = 50;

function candidates() {
  const urls = [];
  for (const v of document.querySelectorAll('video')) {
    if (v.currentSrc) urls.push([v.currentSrc, '', false]);
    if (v.src) urls.push([v.src, '', false]);
    for (const s of v.querySelectorAll('source[src]')) urls.push([s.src, s.type || '', false]);
  }
  for (const sel of ['meta[property="og:video"]', 'meta[property="og:video:url"]', 'meta[property="og:video:secure_url"]', 'meta[name="twitter:player:stream"]']) {
    for (const m of document.querySelectorAll(sel)) {
      if (m.content) urls.push([m.content, '', true]);
    }
  }
  return urls;
}

function scan() {
  for (const [raw, mime, fromMeta] of candidates()) {
    if (seen.size >= MAX_URLS) return;
    let url;
    try {
      url = new URL(raw, location.href).href;
    } catch {
      continue;
    }
    if (!/^https?:/i.test(url) || seen.has(url)) continue;
    seen.add(url);
    chrome.runtime.sendMessage({ type: 'dom-video', url, mime, fromMeta, frameUrl: location.href }).catch(() => {});
  }
}

let timer = null;
function schedule() {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    scan();
  }, 1000);
}

scan();
new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
document.addEventListener('loadedmetadata', schedule, true);
