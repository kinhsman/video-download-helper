const $ = (id) => document.getElementById(id);

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

// Lucide icons (ISC licence), fixed strings only
const SVG = (inner) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
const ICONS = {
  refresh: SVG('<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>'),
  download: SVG('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/>'),
  x: SVG('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'),
  mute: SVG('<path d="M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z"/><line x1="22" x2="16" y1="9" y2="15"/><line x1="16" x2="22" y1="9" y2="15"/>'),
  record: SVG('<circle cx="12" cy="12" r="10"/>'),
  lock: SVG('<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>'),
};
function icon(name) {
  const s = document.createElement('span');
  s.className = 'ico';
  s.setAttribute('aria-hidden', 'true');
  s.innerHTML = ICONS[name];
  return s;
}

const fmtBytes = (n) => {
  if (!n) return '';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
};
const fmtDur = (s) => {
  if (!s) return '';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.round(s % 60);
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
};
function ago(ms) {
  const m = Math.round((Date.now() - ms) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  return `${Math.round(m / 60)} h ago`;
}
function versionIsNewer(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0;
  }
  return false;
}
// "/Users/me/Downloads/VideoHelper/x.mp4" -> "Downloads/VideoHelper/x.mp4"
function tidyPath(path) {
  const m = path.match(/(Downloads[\\/].*)$/);
  return m ? m[1] : path.split(/[\\/]/).pop();
}

const ask = async (msg) => {
  const r = await chrome.runtime.sendMessage(msg);
  if (r?.error) throw new Error(r.error);
  return r;
};

// ---------- state ----------

let tabId = null;
let helper = { state: 'unknown' };
let items = [];
let jobs = [];
let history = [];
let prefs = { quality: 'best', cookies: false, subMode: 'off', subLangs: 'en' };
let streamSite = false;
let protectedSite = false;
let showMinor = false;
let update = null;
let repoCfg = { repo: '', branch: 'main' };
let isWindows = false;
let activeTab = 'page';
const expandedTitles = new Set();
// Each download unit keeps its own progress, so a download shows where its button is.
const unitRefs = new Map(); // item key -> { slot, btn, cancel, note, refresh, running, jobId }
const pageRef = { running: false, jobId: null };

const savePrefs = () => chrome.storage.local.set({ prefs });
const subsPayload = () => (prefs.subMode === 'off' ? undefined : { mode: prefs.subMode, langs: (prefs.subLangs || 'en').replace(/\s+/g, '') });
const installCmd = () => {
  const base = `https://raw.githubusercontent.com/${repoCfg.repo}/${repoCfg.branch}`;
  return isWindows ? `irm ${base}/install.ps1 | iex` : `curl -fsSL ${base}/install.sh | bash`;
};
const shellName = () => (isWindows ? 'PowerShell' : 'Terminal');

async function loadPrefs() {
  const { prefs: p } = await chrome.storage.local.get('prefs');
  prefs = { ...prefs, ...p };
  $('page-quality').value = prefs.quality;
  $('cookies').checked = prefs.cookies;
  $('sub-mode').value = prefs.subMode;
  $('sub-langs').value = prefs.subLangs;
  $('sub-hint').hidden = prefs.subMode === 'off';
}

// ---------- titles that can be opened ----------

// Long titles show two lines and a toggle that opens the whole title. Open state survives re-renders.
function titleBlock(text, key, className) {
  const t = el('div', { class: `${className} clamp`, title: text }, text);
  const toggle = el('button', { class: 'more-link', type: 'button', hidden: true }, 'Show full title');
  const apply = () => {
    const open = expandedTitles.has(key);
    t.classList.toggle('clamp', !open);
    toggle.textContent = open ? 'Show less' : 'Show full title';
  };
  toggle.addEventListener('click', () => {
    if (expandedTitles.has(key)) expandedTitles.delete(key);
    else expandedTitles.add(key);
    apply();
  });
  apply();
  // offer the toggle only when the text really is cut off, and look again whenever the width settles
  const check = () => {
    toggle.hidden = !(expandedTitles.has(key) || t.scrollHeight - t.clientHeight > 6);
  };
  toggle.addEventListener('click', check);
  requestAnimationFrame(check);
  new ResizeObserver(check).observe(t);
  return el('div', { class: 'title-wrap' }, t, toggle);
}

// ---------- what to show for each detected thing ----------

const isBroken = (it) => it.kind === 'hls' && it.hls && it.hls.error && !it.hls.variants.length && !it.hls.duration;
const variantsOf = (it) => it.hls?.variants || [];
const needsHelperFor = (it, variant) => it.kind === 'dash' || it.kind === 'tracks' || !!it.hls?.live || !!variant?.separateAudio;
// Can this run right now? (the helper may be off)
// While the helper is still being checked we assume it works, so the list does not flicker.
const helperMissing = () => helper.state !== 'ok' && helper.state !== 'unknown';
const canRun = (it, variant) => !it.protectedReason && !(needsHelperFor(it, variant) && helperMissing());

function recommendable(it) {
  if (it.protectedReason || isBroken(it) || it.hls?.live) return false;
  if (it.kind === 'file' && streamSite) return false; // a lone file on a site that splits picture and sound may be silent
  return canRun(it, variantsOf(it)[0]);
}
const rank = (it) => ({ tracks: 100, hls: 80, dash: 70, file: 60 })[it.kind] || 0;

function describe(it, variant, recommended, hasMenu = false) {
  const parts = [];
  let label;
  if (it.kind === 'tracks') {
    label = recommended ? 'Full video with sound' : 'Picture and sound, joined';
    parts.push(it.audioUrl ? 'Joined for you' : 'Picture only so far');
    if (it.size) parts.push(fmtBytes(it.size));
  } else if (it.kind === 'hls') {
    const quality = variant ? variant.label.split(' · ')[0] : '';
    label = it.hls?.live ? 'Live stream' : recommended ? 'Full video with sound' : quality && /p/.test(quality) ? `${quality} video` : 'Video stream';
    if (quality && recommended && !hasMenu) parts.push(quality);
    if (it.hls?.duration && !it.hls.live) parts.push(fmtDur(it.hls.duration));
    if (variant?.estBytes && !hasMenu) parts.push(`~${fmtBytes(variant.estBytes)}`);
    if (it.hls?.live) parts.push('Records until you stop');
  } else if (it.kind === 'dash') {
    label = recommended ? 'Full video with sound' : 'Video stream';
    if (it.dash?.duration) parts.push(fmtDur(it.dash.duration));
  } else {
    label = recommended ? 'Full video with sound' : 'Single video file';
    const ext = (it.mime.split(';')[0] || '').replace('video/', '').toUpperCase();
    if (ext) parts.push(ext);
    if (it.size) parts.push(fmtBytes(it.size));
  }
  return { label, meta: parts.join(' · ') };
}

function revealButton(j) {
  return el('button', {
    class: 'mw-btn mw-btn--secondary mw-btn--sm',
    type: 'button',
    onclick: async (e) => {
      try {
        await ask({ type: 'reveal', jobId: j.id });
      } catch (err) {
        e.currentTarget.replaceWith(el('span', { class: 'detail' }, err.message));
      }
    },
  }, 'Show in folder');
}

// Progress or result for one download, shown inside the unit that started it.
function jobInline(j) {
  const pct = j.status === 'done' ? 100 : j.percent || 0;
  if (j.status === 'running') {
    return el('div', { class: 'job-inline running' },
      el('div', { class: 'bar' }, el('i', { style: `width:${pct}%` })),
      el('div', { class: 'detail' }, pct > 0 ? `${pct}% · ${j.detail || 'Downloading'}` : j.detail || 'Starting'),
    );
  }
  if (j.status === 'done') {
    return el('div', { class: 'job-inline done' },
      el('div', { class: 'detail' }, `${j.detail || 'Saved'}: ${j.filename ? tidyPath(j.filename) : ''}`),
      j.filename && el('div', {}, revealButton(j)),
    );
  }
  if (j.status === 'error') return el('div', { class: 'job-inline error' }, el('div', { class: 'detail' }, `Failed: ${j.detail || 'unknown error'}`));
  return el('div', { class: 'job-inline' }, el('div', { class: 'detail' }, 'Canceled'));
}

// One detected thing: the recommended card (rec) or a row.
function unit(it, { rec = false } = {}) {
  const ref = { running: false, jobId: null };
  const variants = variantsOf(it);
  const select = variants.length > 1
    ? el('select', { 'aria-label': 'Quality' }, variants.map((v) => el('option', { value: v.url }, `${v.label}${v.estBytes ? ` · ~${fmtBytes(v.estBytes)}` : ''}`)))
    : null;
  const chosen = () => variants.find((v) => v.url === select?.value) || variants[0];

  const labelEl = el('span', {});
  const metaEl = el('div', { class: 'unit-meta' });
  const badges = el('span', { class: 'unit-badges', style: 'display:contents' });
  const paint = () => {
    const d = describe(it, chosen(), rec, !!select);
    labelEl.textContent = d.label;
    metaEl.textContent = d.meta;
    metaEl.hidden = !d.meta;
  };
  paint();
  if (it.hls?.live) badges.append(el('span', { class: 'badge badge--solid-bad' }, 'Live'));
  if (it.protectedReason) badges.append(el('span', { class: 'badge badge--bad' }, icon('lock'), 'Protected'));
  if (it.minor) badges.append(el('span', { class: 'badge badge--warn' }, it.minor));

  const note = el('div', { class: 'note', hidden: true });
  const unreadable = isBroken(it);
  const dlLabel = it.hls?.live ? 'Record' : 'Download';
  const btn = el('button', {
    class: `mw-btn ${rec ? 'mw-btn--primary' : 'mw-btn--secondary'} mw-btn--sm`,
    type: 'button',
    onclick: async () => {
      btn.disabled = true;
      note.hidden = true;
      note.dataset.error = '';
      try {
        await ask({ type: 'download', tabId, itemKey: it.key, variantUrl: select?.value, quality: prefs.quality, cookies: prefs.cookies, subs: subsPayload() });
      } catch (err) {
        note.textContent = err.message;
        note.hidden = false;
        note.dataset.error = '1';
      }
      ref.refresh();
    },
  }, rec ? icon('download') : null, dlLabel);
  const cancel = el('button', {
    class: 'mw-iconbtn',
    type: 'button',
    title: 'Cancel',
    'aria-label': 'Cancel',
    hidden: true,
    onclick: () => ref.jobId && ask({ type: 'cancel', jobId: ref.jobId }),
  }, icon('x'));

  ref.refresh = () => {
    const v = chosen();
    const missing = !it.protectedReason && needsHelperFor(it, v) && helperMissing();
    btn.hidden = ref.running || !!it.protectedReason;
    btn.disabled = missing || unreadable;
    cancel.hidden = !ref.running;
    if (!ref.running && !note.dataset.error) {
      note.textContent = missing ? 'This one needs the helper app. Turn it on at the bottom of this window.' : '';
      note.hidden = !missing;
    }
  };
  select?.addEventListener('change', () => {
    note.dataset.error = '';
    paint();
    ref.refresh();
  });

  const slot = el('div', { class: 'job-slot' });
  Object.assign(ref, { slot, btn, cancel, note });
  unitRefs.set(it.key, ref);
  ref.refresh();

  return el('div', { class: `unit ${rec ? 'rec' : 'line'}` },
    el('div', { class: 'unit-head' },
      el('div', { class: 'unit-text' }, el('div', { class: 'unit-label' }, labelEl, badges), metaEl),
      el('div', { class: 'unit-actions' }, btn, cancel),
    ),
    select && el('div', { class: 'unit-quality' }, select),
    note,
    slot,
  );
}

// The page itself, when nothing better is on offer: the helper looks for the video.
function pageUnit() {
  const ref = { running: false, jobId: null };
  const note = el('div', { class: 'note', hidden: true });
  const btn = el('button', {
    class: 'mw-btn mw-btn--primary mw-btn--sm',
    type: 'button',
    onclick: () => startPageDownload(note),
  }, icon('download'), 'Download');
  const cancel = el('button', { class: 'mw-iconbtn', type: 'button', title: 'Cancel', 'aria-label': 'Cancel', hidden: true, onclick: () => ref.jobId && ask({ type: 'cancel', jobId: ref.jobId }) }, icon('x'));
  const slot = el('div', { class: 'job-slot' });
  ref.refresh = () => {
    btn.hidden = ref.running;
    cancel.hidden = !ref.running;
  };
  Object.assign(ref, { slot, btn, cancel, note });
  unitRefs.set('page', ref);
  return el('div', { class: 'unit rec' },
    el('div', { class: 'unit-head' },
      el('div', { class: 'unit-text' }, el('div', { class: 'unit-label' }, 'Full video with sound'), el('div', { class: 'unit-meta' }, 'Let the helper find it on this page')),
      el('div', { class: 'unit-actions' }, btn, cancel),
    ),
    note,
    slot,
  );
}

async function startPageDownload(noteEl) {
  if (noteEl) noteEl.hidden = true;
  try {
    await ask({ type: 'download-page', tabId, quality: prefs.quality, cookies: prefs.cookies, subs: subsPayload() });
  } catch (err) {
    if (noteEl) {
      noteEl.textContent = err.message;
      noteEl.hidden = false;
    }
  }
}

// ---------- the This page tab ----------

function renderNotice() {
  const box = $('notice');
  box.replaceChildren();
  if (protectedSite) {
    box.hidden = false;
    box.append(el('div', { class: 'banner banner--bad' }, el('p', {}, 'The video on this page is copy-protected (DRM). It only plays inside the site\'s own player, so this tool cannot save it, and it will not try to get around that.')));
    return;
  }
  if (streamSite && helper.state !== 'ok' && helper.state !== 'unknown') {
    box.hidden = false;
    const banner = el('div', { class: 'banner banner--warn' }, el('p', {}, 'This site keeps picture and sound in separate files. Turn on the helper to get the full video with sound.'));
    if (helper.state === 'no-permission') banner.append(el('div', {}, enableHelperButton('Enable helper')));
    else if (helper.state === 'missing') banner.append(el('p', {}, `The helper is not installed. Run this in ${shellName()}, then reopen:`), el('code', {}, installCmd()));
    box.append(banner);
    return;
  }
  box.hidden = true;
}

function enableHelperButton(label) {
  return el('button', {
    class: 'mw-btn mw-btn--primary mw-btn--sm',
    type: 'button',
    onclick: async () => {
      const ok = await chrome.permissions.request({ permissions: ['nativeMessaging'] });
      if (ok) await refreshHelper();
    },
  }, label);
}

function renderItems() {
  const box = $('list');
  box.replaceChildren();
  unitRefs.clear();

  const shown = items.filter((it) => showMinor || !it.minor);
  const hiddenCount = items.filter((it) => it.minor).length;
  const broken = shown.filter(isBroken);
  const usable = shown.filter((it) => !isBroken(it));

  $('count-page').textContent = items.filter((it) => !it.minor).length ? `· ${items.filter((it) => !it.minor).length}` : '';

  if (shown.length) {
    const title = shown[0].title || shown[0].pageUrl;
    if (title) box.append(el('div', { class: 'page-title' }, titleBlock(title, `title:${tabId}`, 'name')));
  }

  const pick = usable.filter(recommendable).sort((a, b) => rank(b) - rank(a) || (b.size || 0) - (a.size || 0))[0] || null;
  const rest = usable.filter((it) => it !== pick).sort((a, b) => rank(b) - rank(a) || (b.size || 0) - (a.size || 0));

  if (pick || helper.state === 'ok') {
    box.append(el('div', { class: 'eyebrow' }, 'Recommended'));
    box.append(pick ? unit(pick, { rec: true }) : pageUnit());
  }

  if (rest.length) {
    box.append(el('div', { class: 'eyebrow' }, 'Other downloads', streamSite && rest.some((it) => it.kind === 'file')
      ? el('span', { class: 'badge badge--warn' }, icon('mute'), 'May be silent')
      : null));
    const list = el('div', {});
    for (const it of rest) list.append(unit(it));
    box.append(list);
  }

  if (!shown.length) {
    box.append(el('div', { class: 'empty' }, `No videos found yet. Press play on the video, then scan again.${helper.state === 'ok' ? '' : ''}`));
  }

  if (broken.length) {
    box.append(el('div', { class: 'fold' },
      el('span', {}, broken.length === 1 ? "1 file couldn't be read" : `${broken.length} files couldn't be read`),
      el('button', { class: 'mw-btn mw-btn--secondary mw-btn--sm', type: 'button', onclick: scanAgain }, 'Scan again'),
    ));
  }

  if (hiddenCount) {
    box.append(el('div', { class: 'fold-more' }, el('button', {
      class: 'mw-btn mw-btn--secondary mw-btn--sm',
      type: 'button',
      onclick: () => {
        showMinor = !showMinor;
        renderItems();
      },
    }, showMinor ? 'Hide previews and short clips' : `Show ${hiddenCount} hidden (previews, ads, short clips)`)));
  }

  $('more').hidden = helper.state !== 'ok';
  renderJobs();
}

async function scanAgain() {
  const btn = $('detect');
  btn.classList.add('spin');
  await ask({ type: 'force-detect', tabId });
  window.close();
}

// ---------- jobs, the Downloads tab ----------

const latestJobFor = (key) => [...jobs].filter((j) => j.itemKey === key).sort((x, y) => y.startedAt - x.startedAt)[0];

function jobRow(j) {
  const label = { running: `${j.percent || 0}%`, done: 'Done', error: 'Failed', canceled: 'Canceled' }[j.status] || j.status;
  return el('div', { class: `job ${j.status}`, 'data-id': j.id },
    el('div', { class: 'top' },
      titleBlock(j.title, `job:${j.id}`, 'title'),
      j.status !== 'running' && el('span', { class: 'detail' }, label),
    ),
    j.status === 'running' && el('div', { class: 'bar' }, el('i', { style: `width:${j.percent || 0}%` })),
    el('div', { class: 'detail' }, j.status === 'done' && j.filename ? `${j.detail || 'Saved'}: ${tidyPath(j.filename)}` : j.detail || ''),
    el('div', { class: 'acts' },
      j.status === 'running' && el('button', { class: 'mw-btn mw-btn--secondary mw-btn--sm', type: 'button', onclick: () => ask({ type: 'cancel', jobId: j.id }) }, 'Cancel'),
      j.status === 'done' && j.filename && revealButton(j),
    ),
  );
}

function renderJobs() {
  // Updates progress inside each unit without rebuilding it, so a quality choice is not lost mid-download.
  for (const [key, ref] of unitRefs) {
    const j = latestJobFor(key);
    ref.running = j?.status === 'running';
    ref.jobId = j?.status === 'running' ? j.id : null;
    ref.slot.replaceChildren(...(j ? [jobInline(j)] : []));
    ref.refresh();
  }
  // whole-page progress also shows under More options
  const pj = latestJobFor('page');
  pageRef.running = pj?.status === 'running';
  pageRef.jobId = pageRef.running ? pj.id : null;
  $('page-job').replaceChildren(...(pj ? [jobInline(pj)] : []));
  $('page-go').disabled = pageRef.running;
  $('page-go').textContent = pageRef.running ? 'Downloading...' : 'Download page';

  const sorted = [...jobs].sort((a, b) => b.startedAt - a.startedAt);
  const known = new Set(sorted.map((j) => j.id));
  const older = history.filter((h) => !known.has(h.id)).slice(0, 15);
  $('jobs').replaceChildren(...sorted.slice(0, 20).map(jobRow));
  $('history-label').hidden = !older.length || !sorted.length;
  $('history').replaceChildren(...older.map((h) => jobRow({ ...h, status: h.status, startedAt: h.time, filename: h.filename })));
  $('dl-empty').hidden = sorted.length + older.length > 0;
  const total = sorted.length + older.length;
  $('count-dl').textContent = total ? `· ${total}` : '';
}

async function loadJobs() {
  const { jobs: stored = [] } = await chrome.storage.session.get('jobs');
  jobs = stored;
  renderJobs();
}
async function loadHistory() {
  ({ history = [] } = await chrome.storage.local.get('history'));
  renderJobs();
}

async function pollDirectProgress() {
  for (const j of jobs) {
    if (j.status !== 'running' || !j.downloadId) continue;
    const [d] = await chrome.downloads.search({ id: j.downloadId });
    if (d && d.totalBytes > 0) {
      j.percent = Math.round((d.bytesReceived / d.totalBytes) * 100);
      j.detail = `${fmtBytes(d.bytesReceived)} of ${fmtBytes(d.totalBytes)}`;
    } else if (d) {
      j.detail = fmtBytes(d.bytesReceived);
    }
  }
  renderJobs();
}

// ---------- footer: helper status, update button, sheets ----------

function helperStatus() {
  const current = chrome.runtime.getManifest().version;
  if (helper.state === 'ok') {
    const problem = !helper.ytdlp_path || !helper.ffmpeg || !helper.jsruntime;
    return problem ? { tone: 'warn', text: 'Helper needs attention' } : { tone: 'ok', text: `Helper ready · v${current}` };
  }
  if (helper.state === 'no-permission') return { tone: 'off', text: 'Helper is off' };
  if (helper.state === 'missing') return { tone: 'off', text: 'Helper not installed' };
  return { tone: 'off', text: 'Checking helper...' };
}

function renderDiag() {
  const box = $('diag');
  box.replaceChildren();
  if (helper.state === 'ok') {
    const yt = helper.ytdlp ? `yt-dlp ${helper.ytdlp}` : helper.ytdlp_path ? 'yt-dlp found but slow to answer' : 'yt-dlp not found';
    const ff = helper.ffmpeg ? 'ffmpeg ok' : 'ffmpeg not found';
    const js = helper.jsruntime ? `${helper.jsruntime} found` : 'no JavaScript runtime';
    box.append(el('div', { class: 'sheet-title' }, 'Helper'), el('div', { class: 'detail' }, `${yt} · ${ff} · ${js}`));
    if (!helper.ytdlp_path || !helper.ffmpeg || !helper.jsruntime) {
      box.append(el('p', {}, `Missing tools are installed by the install command. Run it again in ${shellName()}, then reopen:`), el('code', {}, installCmd()));
    }
  } else if (helper.state === 'no-permission') {
    box.append(el('div', { class: 'sheet-title' }, 'The helper is off'), el('p', {}, 'It handles YouTube-style sites, picture and sound that come as two files, live streams and updates.'), el('div', {}, enableHelperButton('Enable helper')));
  } else if (helper.state === 'missing') {
    box.append(el('div', { class: 'sheet-title' }, 'The helper is not installed'), el('p', {}, `Run this in ${shellName()}, then reopen:`), el('code', {}, installCmd()));
  } else {
    box.append(el('div', { class: 'detail' }, 'Checking the helper...'));
  }
}

function renderStatus() {
  const s = helperStatus();
  $('status-dot').className = `dot ${s.tone === 'ok' ? 'ok' : s.tone === 'warn' ? 'warn' : ''}`;
  $('status-text').textContent = s.text;
  if (!$('diag').hidden) renderDiag();
}

function updateAvailable() {
  return !!update?.latest && versionIsNewer(update.latest, chrome.runtime.getManifest().version);
}

function updateNoteText() {
  if (!update?.checkedAt) return '';
  if (update.error) return `Could not check (${update.error}).`;
  if (updateAvailable()) return '';
  const base = `Latest published: ${update.latest}. Checked ${ago(update.checkedAt)}.`;
  if (versionIsNewer(update.current, update.latest)) return `Up to date, this copy is newer than the published ${update.latest}. Checked ${ago(update.checkedAt)}.`;
  return `Up to date. ${base}`;
}

function renderUpdateSheet() {
  const box = $('update');
  box.replaceChildren();
  if (!updateAvailable()) {
    box.hidden = true;
    return;
  }
  const current = chrome.runtime.getManifest().version;
  box.append(el('div', { class: 'sheet-title' }, `Version ${update.latest} is available`), el('div', { class: 'detail' }, `You have ${current}.${update.notes ? ' ' + update.notes : ''}`));
  if (helper.state === 'ok' && helper.installed) {
    const msg = el('div', { class: 'detail' }, 'Also installs missing tools and refreshes yt-dlp. Can take a minute or two.');
    box.append(
      el('div', {}, el('button', {
        class: 'mw-btn mw-btn--primary mw-btn--sm',
        type: 'button',
        onclick: async (e) => {
          const btn = e.currentTarget;
          btn.disabled = true;
          btn.textContent = 'Updating...';
          // the background tells us what the helper is doing; it reloads the extension itself when done
          const live = (changes, area) => {
            if (area === 'session' && changes.updateProgress) msg.textContent = changes.updateProgress.newValue || '';
          };
          chrome.storage.onChanged.addListener(live);
          try {
            const r = await ask({ type: 'apply-update' });
            btn.textContent = 'Updated, reloading...';
            msg.textContent = (r.notes || []).join(' · ') || `Now version ${r.version}`;
          } catch (err) {
            chrome.storage.onChanged.removeListener(live);
            btn.disabled = false;
            btn.textContent = 'Update now';
            msg.textContent = err.message;
          }
        },
      }, 'Update now')),
      msg,
    );
  } else if (helper.state === 'ok') {
    box.append(el('p', {}, 'This is a development copy, so it cannot update itself. Update it with git pull, then reload the extension.'));
  } else if (helper.state === 'no-permission') {
    box.append(
      el('p', {}, 'Updating needs the helper app switched on in this browser.'),
      el('div', {}, enableHelperButton('Enable helper, then update')),
      el('div', { class: 'detail' }, `Or run this in ${shellName()}, then press the reload arrow on this extension in chrome://extensions:`),
      el('code', {}, installCmd()),
    );
  } else {
    box.append(el('div', { class: 'detail' }, `Run this in ${shellName()}, then press the reload arrow on this extension in chrome://extensions:`), el('code', {}, installCmd()));
  }
}

function renderFooter(justChecked = false) {
  renderStatus();
  const box = $('version');
  box.replaceChildren();
  const available = updateAvailable();
  const btn = el('button', {
    class: `mw-btn ${available ? 'mw-btn--primary' : 'mw-btn--secondary'} mw-btn--sm`,
    type: 'button',
    onclick: available ? toggleUpdate : checkForUpdates,
  }, available ? 'Update available' : 'Check for updates');
  box.append(btn);
  const note = $('version-note');
  const text = updateNoteText();
  note.textContent = text;
  note.hidden = !text;
  renderUpdateSheet();
  if (available) {
    if (justChecked) {
      $('update').hidden = false;
      $('update').scrollIntoView({ block: 'nearest' });
    }
  } else {
    $('update').hidden = true;
  }
}

function toggleUpdate() {
  const sheet = $('update');
  sheet.hidden = !sheet.hidden;
  if (!sheet.hidden) {
    $('diag').hidden = true;
    $('status').setAttribute('aria-expanded', 'false');
    sheet.scrollIntoView({ block: 'nearest' });
  }
}

async function checkForUpdates(e) {
  const btn = e.currentTarget;
  btn.disabled = true;
  btn.textContent = 'Checking...';
  $('version-note').hidden = true;
  const current = chrome.runtime.getManifest().version;
  try {
    const [result] = await Promise.all([ask({ type: 'check-update' }), new Promise((r) => setTimeout(r, 600))]);
    update = result;
  } catch (err) {
    update = { ...(update || {}), current, error: err.message, checkedAt: Date.now() };
  }
  renderFooter(true);
}

// ---------- data refresh ----------

async function refreshItems() {
  ({ items, streamSite, protectedSite } = await ask({ type: 'list', tabId }));
  renderNotice();
  renderItems();
}

async function refreshHelper() {
  helper = await ask({ type: 'helper-state' });
  renderStatus();
  renderNotice();
  renderItems();
  renderFooter();
}

function selectTab(name) {
  activeTab = name;
  $('tab-page').setAttribute('aria-selected', String(name === 'page'));
  $('tab-dl').setAttribute('aria-selected', String(name === 'dl'));
  $('panel-page').hidden = name !== 'page';
  $('panel-dl').hidden = name !== 'dl';
}

async function init() {
  $('detect').append(icon('refresh'));
  // ?tab=<id> lets tests open the popup as a normal tab for a specific page.
  const forced = Number(new URLSearchParams(location.search).get('tab'));
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = forced || tab?.id;
  await loadPrefs();
  repoCfg = await (await fetch(chrome.runtime.getURL('repo.json'))).json();
  isWindows = (await chrome.runtime.getPlatformInfo()).os === 'win';
  update = await ask({ type: 'update-state' });
  renderFooter();
  await Promise.all([refreshItems(), loadJobs(), loadHistory()]);
  refreshHelper();

  $('detect').addEventListener('click', scanAgain);
  $('tab-page').addEventListener('click', () => selectTab('page'));
  $('tab-dl').addEventListener('click', () => selectTab('dl'));
  $('status').addEventListener('click', () => {
    const open = $('diag').hidden;
    $('diag').hidden = !open;
    $('status').setAttribute('aria-expanded', String(open));
    if (open) {
      $('update').hidden = true;
      renderDiag();
      $('diag').scrollIntoView({ block: 'nearest' });
    }
  });
  $('page-quality').addEventListener('change', (e) => {
    prefs.quality = e.target.value;
    savePrefs();
  });
  $('sub-mode').addEventListener('change', (e) => {
    prefs.subMode = e.target.value;
    $('sub-hint').hidden = prefs.subMode === 'off';
    savePrefs();
  });
  $('sub-langs').addEventListener('change', (e) => {
    prefs.subLangs = e.target.value.trim() || 'en';
    e.target.value = prefs.subLangs;
    savePrefs();
  });
  $('cookies').addEventListener('change', (e) => {
    prefs.cookies = e.target.checked;
    savePrefs();
  });
  $('page-go').addEventListener('click', async (e) => {
    e.currentTarget.disabled = true;
    await startPageDownload($('page-note'));
    e.currentTarget.disabled = pageRef.running;
  });
  $('clear').addEventListener('click', async () => {
    await ask({ type: 'clear-jobs' });
    await ask({ type: 'clear-history' });
    await loadJobs();
    await loadHistory();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'session' && changes.jobs) {
      jobs = changes.jobs.newValue || [];
      renderJobs();
    }
    if (area === 'session' && changes[`items:${tabId}`]) refreshItems();
    if (area === 'session' && changes[`tracks:${tabId}`]) refreshItems();
    if (area === 'local' && changes.history) loadHistory();
  });
  setInterval(pollDirectProgress, 800);
}

init();
