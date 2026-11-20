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

const ask = async (msg) => {
  const r = await chrome.runtime.sendMessage(msg);
  if (r?.error) throw new Error(r.error);
  return r;
};

let tabId = null;
let helper = { state: 'unknown' };
let items = [];
let streamSite = false;
let protectedSite = false;
let showMinor = false;
let update = null;
let repoCfg = { repo: '', branch: 'main' };
let isWindows = false;
// Each card keeps its own download progress, so a download shows where its Download button is.
const cardRefs = new Map(); // item key -> { slot, btn, note, refreshBlocked, running }
const pageRef = { running: false };
let jobs = [];
let prefs = { quality: 'best', cookies: false, subMode: 'off', subLangs: 'en' };

async function loadPrefs() {
  const { prefs: p } = await chrome.storage.local.get('prefs');
  prefs = { ...prefs, ...p };
  $('page-quality').value = prefs.quality;
  $('cookies').checked = prefs.cookies;
  $('sub-mode').value = prefs.subMode;
  $('sub-langs').value = prefs.subLangs;
  $('sub-hint').hidden = prefs.subMode === 'off';
}
const savePrefs = () => chrome.storage.local.set({ prefs });
// What to ask yt-dlp for. Spaces are dropped so "en, vi" works.
const subsPayload = () => (prefs.subMode === 'off' ? undefined : { mode: prefs.subMode, langs: (prefs.subLangs || 'en').replace(/\s+/g, '') });

function chip(text, kind = '') {
  return el('span', { class: `chip ${kind}` }, text);
}

// Long titles show two lines and a toggle that opens the whole title. Open state survives re-renders.
const expandedTitles = new Set();
function titleBlock(text, key, className) {
  const t = el('div', { class: `${className} clamp`, title: text }, text);
  const toggle = el('button', { class: 'link more', hidden: true }, 'Show full title');
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

// "manifest.googlevideo.com · hls_playlist" says more than a 300 character address.
function shortSource(url) {
  try {
    const u = new URL(url);
    const tail = u.pathname.split('/').filter(Boolean).pop() || '';
    return tail ? `${u.hostname} · ${tail}` : u.hostname;
  } catch {
    return url;
  }
}

// Before the helper is set up this is a warning, afterwards it just says how the download will run.
function helperChip() {
  return helper.state === 'ok' ? chip('downloads via helper') : chip('needs helper', 'warn');
}

function renderItems() {
  const box = $('list');
  box.replaceChildren();
  if (!items.length) {
    box.append(el('div', { class: 'empty' }, 'No videos found yet. Press play on the video, then reopen this. If nothing shows, try Force detect.'));
    return;
  }
  const shown = items.filter((it) => showMinor || !it.minor);
  cardRefs.clear();
  for (const it of shown) {
    const ref = { running: false };
    const hls = it.hls;
    const chips = [];
    let select = null;

    if (it.kind === 'file') {
      chips.push(chip((it.mime.split(';')[0] || 'video file').replace('video/', '').toUpperCase() || 'VIDEO'));
      if (it.size) chips.push(chip(fmtBytes(it.size)));
      if (it.protectedReason) chips.push(chip(`protected: ${it.protectedReason}`, 'bad'));
      else if (streamSite) chips.push(chip('may have no sound', 'warn'));
    } else if (it.kind === 'hls') {
      chips.push(chip('HLS stream'));
      if (!hls) chips.push(chip('checking...'));
      else {
        if (hls.duration && !hls.live) chips.push(chip(fmtDur(hls.duration)));
        if (hls.live) chips.push(chip('live', 'warn'));
        if (hls.protected) chips.push(chip(`protected: ${hls.protected}`, 'bad'));
        if (hls.error && !hls.variants.length) chips.push(chip('could not read playlist', 'warn'));
        if (it.needsHelper) chips.push(helperChip());
        if (hls.variants.length) {
          select = el(
            'select',
            { 'aria-label': 'Quality' },
            hls.variants.map((v) => {
              const est = v.estBytes ? ` · ~${fmtBytes(v.estBytes)}` : '';
              return el('option', { value: v.url }, `${v.label}${est}`);
            }),
          );
        }
      }
    } else if (it.kind === 'dash') {
      chips.push(chip('DASH stream'));
      if (it.dash?.duration) chips.push(chip(fmtDur(it.dash.duration)));
      if (it.protectedReason) chips.push(chip(`protected: ${it.protectedReason}`, 'bad'));
      else chips.push(helperChip());
    }

    // Does the chosen quality need the helper, and is the helper missing?
    const variantNeedsHelper = () => it.kind === 'dash' || !!hls?.live || !!hls?.variants.find((v) => v.url === select?.value)?.separateAudio;
    const note = el('div', { class: 'note' });
    const unreadable = it.kind === 'hls' && hls && hls.error && !hls.variants.length && !hls.duration;
    const refreshBlocked = () => {
      const missing = !it.protectedReason && variantNeedsHelper() && helper.state !== 'ok';
      btn.disabled = !!it.protectedReason || missing || unreadable || ref.running;
      btn.textContent = ref.running ? 'Downloading...' : 'Download';
      note.textContent = unreadable ? 'This playlist could not be read. Try Force detect.' : missing ? 'This one needs the helper app (see the bottom of this window).' : '';
      note.hidden = !(missing || unreadable);
    };
    const btn = el('button', {
      disabled: true,
      onclick: async () => {
        btn.disabled = true;
        note.hidden = true;
        try {
          await ask({ type: 'download', tabId, itemKey: it.key, variantUrl: select?.value, quality: prefs.quality, cookies: prefs.cookies, subs: subsPayload() });
        } catch (err) {
          note.textContent = err.message;
          note.hidden = false;
        }
        refreshBlocked();
      },
    }, 'Download');

    if (it.minor) chips.push(chip(it.minor, 'warn'));
    const name = it.title || it.pageUrl || 'Video';
    const slot = el('div', { class: 'job-slot' });
    Object.assign(ref, { slot, btn, note, refreshBlocked });
    cardRefs.set(it.key, ref);
    box.append(
      el('div', { class: 'card' },
        titleBlock(name, `card:${it.key}`, 'name'),
        el('div', { class: 'url', title: it.url }, shortSource(it.url)),
        el('div', { class: 'chips' }, chips),
        el('div', { class: 'row' }, select, !select && el('span', { style: 'flex:1' }), btn),
        note,
        slot,
      ),
    );
    select?.addEventListener('change', refreshBlocked);
    refreshBlocked();
  }
  appendMinorToggle();
  renderJobs();
}

function appendMinorToggle() {
  const hiddenCount = items.filter((it) => it.minor).length;
  if (!hiddenCount) return;
  $('list').append(el('button', {
    class: 'link',
    onclick: () => {
      showMinor = !showMinor;
      renderItems();
    },
  }, showMinor ? 'Hide previews and short clips' : `Show ${hiddenCount} hidden (previews, ads, short clips)`));
}

function revealButton(j) {
  return el('button', {
    class: 'link',
    onclick: async (e) => {
      try {
        await ask({ type: 'reveal', jobId: j.id });
      } catch (err) {
        e.target.replaceWith(el('span', { class: 'detail' }, err.message));
      }
    },
  }, 'Show in folder');
}

// Progress or result for one download, shown inside the card that started it.
function jobInline(j) {
  const pct = j.status === 'done' ? 100 : j.percent || 0;
  let text;
  if (j.status === 'running') text = pct > 0 ? `${pct}% · ${j.detail || 'Downloading'}` : j.detail || 'Starting';
  else if (j.status === 'done') text = `${j.detail || 'Saved'}: ${j.filename ? tidyPath(j.filename) : ''}`;
  else if (j.status === 'error') text = `Failed: ${j.detail || 'unknown error'}`;
  else text = 'Canceled';
  return el('div', { class: `job-inline ${j.status}` },
    j.status === 'running' && el('progress', { max: 100, value: pct }),
    el('div', { class: 'top' },
      el('div', { class: 'detail' }, text),
      j.status === 'running' && el('button', { class: 'link', onclick: () => ask({ type: 'cancel', jobId: j.id }) }, 'Cancel'),
      j.status === 'done' && j.filename && revealButton(j),
    ),
  );
}

// Downloads that have no card to live in (the video is gone from the list) keep the separate row.
function jobRow(j, withProgress) {
  const pct = j.status === 'done' ? 100 : j.percent || 0;
  const label = { running: `${pct}%`, done: 'Done', error: 'Failed', canceled: 'Canceled' }[j.status] || j.status;
  return el('div', { class: `job ${j.status}`, 'data-id': j.id },
    el('div', { class: 'top' },
      titleBlock(j.title, `job:${j.id}`, 'title'),
      j.status === 'running'
        ? el('button', { class: 'link', onclick: () => ask({ type: 'cancel', jobId: j.id }) }, 'Cancel')
        : el('span', { class: 'detail' }, label),
    ),
    withProgress && j.status === 'running' && el('progress', { max: 100, value: pct }),
    j.status === 'done' && j.filename
      ? el('div', { class: 'detail' }, `${j.detail || 'Saved'}: ${tidyPath(j.filename)} `, revealButton(j))
      : el('div', { class: 'detail' }, j.detail || ''),
  );
}

// "/Users/me/Downloads/VideoHelper/x.mp4" -> "Downloads/VideoHelper/x.mp4"
function tidyPath(path) {
  const m = path.match(/(Downloads[\\/].*)$/);
  return m ? m[1] : path.split(/[\\/]/).pop();
}

const latestJobFor = (key) => [...jobs].filter((j) => j.itemKey === key).sort((x, y) => y.startedAt - x.startedAt)[0];

function renderJobs() {
  // Updates the progress inside each card without rebuilding it, so a quality choice is not lost mid-download.
  for (const [key, ref] of cardRefs) {
    const j = latestJobFor(key);
    ref.running = j?.status === 'running';
    ref.slot.replaceChildren(...(j ? [jobInline(j)] : []));
    ref.refreshBlocked();
  }
  const pageVisible = !$('page-dl').hidden;
  const pj = latestJobFor('page');
  pageRef.running = pj?.status === 'running';
  $('page-job').replaceChildren(...(pj && pageVisible ? [jobInline(pj)] : []));
  $('page-go').disabled = pageRef.running;
  $('page-go').textContent = pageRef.running ? 'Downloading...' : 'Download page';

  const rest = [...jobs]
    .filter((j) => !cardRefs.has(j.itemKey) && !(j.itemKey === 'page' && pageVisible))
    .sort((a, b) => b.startedAt - a.startedAt);
  $('jobs-section').hidden = !rest.length;
  $('jobs').replaceChildren(...rest.slice(0, 6).map((j) => jobRow(j, true)));
}

async function renderHistory() {
  const { history = [] } = await chrome.storage.local.get('history');
  $('history-section').hidden = !history.length;
  $('history').replaceChildren(
    ...history.slice(0, 15).map((h) => el('div', { class: `job ${h.status}` },
      el('div', { class: 'top' }, titleBlock(h.title, `hist:${h.id}`, 'title'), el('span', { class: 'detail' }, h.status === 'done' ? 'Done' : 'Failed')),
      el('div', { class: 'detail' }, h.status === 'done' ? h.filename.split('/').pop() : h.detail),
    )),
  );
}

const installCmd = () => {
  const base = `https://raw.githubusercontent.com/${repoCfg.repo}/${repoCfg.branch}`;
  return isWindows ? `irm ${base}/install.ps1 | iex` : `curl -fsSL ${base}/install.sh | bash`;
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

// Judged against the version running now, so a result saved before an update cannot show a stale banner.
function updateAvailable() {
  return !!update?.latest && versionIsNewer(update.latest, chrome.runtime.getManifest().version);
}

function updateStatusText() {
  if (!update?.checkedAt) return '';
  if (update.error) return `Could not check (${update.error}).`;
  const published = `Latest published: ${update.latest}. Checked ${ago(update.checkedAt)}.`;
  if (updateAvailable()) return `Update found. ${published}`;
  if (versionIsNewer(update.current, update.latest)) return `Up to date (this copy is newer than the published ${update.latest}). Checked ${ago(update.checkedAt)}.`;
  return `Up to date. ${published}`;
}

function renderUpdate(justChecked = false) {
  const box = $('update');
  box.replaceChildren();
  const current = chrome.runtime.getManifest().version;
  const status = el('div', { class: 'detail' }, updateStatusText());
  const checkBtn = el('button', {
    class: 'link',
    onclick: async () => {
      checkBtn.disabled = true;
      checkBtn.textContent = 'Checking...';
      status.textContent = '';
      try {
        const [result] = await Promise.all([ask({ type: 'check-update' }), new Promise((r) => setTimeout(r, 600))]);
        update = result;
      } catch (err) {
        update = { ...(update || {}), current, error: err.message, checkedAt: Date.now() };
      }
      renderUpdate(true);
    },
  }, 'Check for updates');
  // What to do about an update. Shown in the blue box at the top AND under the version line,
  // because the popup may be scrolled down when the user presses Check for updates.
  const updateActions = () => {
    if (helper.state === 'ok' && helper.installed) {
      const msg = el('div', { class: 'detail' }, 'Also installs missing tools and refreshes yt-dlp. Can take a minute or two.');
      return el('div', {},
        el('div', { class: 'row' }, el('button', {
          onclick: async (e) => {
            const btn = e.target;
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
    }
    if (helper.state === 'ok') {
      return el('p', {}, 'This is a development copy, so it cannot update itself. Update it with git pull, then reload the extension.');
    }
    if (helper.state === 'no-permission') {
      // The helper app is what swaps the files, so Update now needs it switched on. One click does that.
      return el('div', {},
        el('p', {}, 'Updating needs the helper app switched on in this browser.'),
        el('div', { class: 'row' }, el('button', {
          onclick: async () => {
            const ok = await chrome.permissions.request({ permissions: ['nativeMessaging'] });
            if (ok) await refreshHelper();
          },
        }, 'Enable helper, then update')),
        el('p', { class: 'detail' }, `Or run this in ${isWindows ? 'PowerShell' : 'Terminal'}, then press the reload arrow on this extension in chrome://extensions:`),
        el('code', {}, installCmd()),
      );
    }
    return el('div', {},
      el('p', {}, `Run this in ${isWindows ? 'PowerShell' : 'Terminal'}, then press the reload arrow on this extension in chrome://extensions:`),
      el('code', {}, installCmd()),
    );
  };

  $('version').replaceChildren(`Version ${current} `, checkBtn, status);
  if (!updateAvailable()) {
    box.hidden = true;
    return;
  }
  const headline = `Update available: version ${update.latest} (you have ${current}).${update.notes ? ' ' + update.notes : ''}`;
  $('version').append(el('div', { class: 'update-inline' }, el('p', {}, headline), updateActions()));
  box.hidden = false;
  box.append(el('p', {}, headline), updateActions());
  if (justChecked) box.scrollIntoView({ block: 'start' });
}

function renderHelper() {
  const f = $('helper');
  f.replaceChildren();
  $('page-dl').hidden = helper.state !== 'ok';
  if (helper.state === 'ok') {
    const yt = helper.ytdlp ? `yt-dlp ${helper.ytdlp}` : helper.ytdlp_path ? 'yt-dlp found but slow to answer' : 'yt-dlp not found';
    const ff = helper.ffmpeg ? 'ffmpeg ok' : 'ffmpeg not found';
    f.append(`Helper connected. ${yt}, ${ff}.`);
    if (helper.state === 'ok' && !helper.jsruntime) f.append(el('div', { class: 'note' }, 'No JavaScript runtime found: YouTube downloads may fail. The install command adds one.'));
    if (!helper.ytdlp_path || !helper.ffmpeg) {
      f.append(
        el('div', {}, `Missing tools are installed by the install command. Run it again in ${isWindows ? 'PowerShell' : 'Terminal'}, then reopen:`),
        el('code', {}, installCmd()),
      );
    }
  } else if (helper.state === 'no-permission') {
    f.append(
      'Optional helper for YouTube-style sites and DASH. ',
      el('button', {
        class: 'link',
        onclick: async () => {
          const ok = await chrome.permissions.request({ permissions: ['nativeMessaging'] });
          if (ok) await refreshHelper();
        },
      }, 'Enable helper'),
    );
  } else if (helper.state === 'missing') {
    f.append(`Helper is not installed. Run this in ${isWindows ? 'PowerShell' : 'Terminal'}, then reopen:`, el('code', {}, installCmd()));
  } else {
    f.append('Checking helper...');
  }
}

// On sites that split picture and sound (DASH), the whole-page download is the reliable route.
function renderHint() {
  const hint = $('hint');
  hint.replaceChildren();
  const page = $('page-dl');
  const found = $('found');
  if (protectedSite) {
    hint.hidden = false;
    page.hidden = true;
    hint.append(el('p', {}, 'The video on this page is copy-protected (DRM). It plays only inside the site\'s own player, so this tool cannot save it, and it will not try to get around that.'));
    return;
  }
  if (!streamSite) {
    hint.hidden = true;
    found.after(page); // normal sites: list first, page download below
    return;
  }
  // stream site: page download goes first
  found.before(page);
  if (helper.state === 'ok') {
    hint.hidden = false;
    hint.append(el('p', {}, 'This site keeps picture and sound in separate files, so single files below may have no sound. Use Download page for the full video with sound.'));
  } else if (helper.state === 'no-permission') {
    hint.hidden = false;
    hint.append(
      el('p', {}, 'This site keeps picture and sound in separate files. Turn on the helper to download the full video with sound.'),
      el('div', { class: 'row' }, el('button', {
        onclick: async () => {
          const ok = await chrome.permissions.request({ permissions: ['nativeMessaging'] });
          if (ok) await refreshHelper();
        },
      }, 'Enable helper')),
    );
  } else if (helper.state === 'missing') {
    hint.hidden = false;
    hint.append(el('p', {}, `This site needs the helper app. Run this in ${isWindows ? 'PowerShell' : 'Terminal'}, then reopen:`), el('code', {}, installCmd()));
  } else {
    hint.hidden = true;
  }
}

async function refreshItems() {
  ({ items, streamSite, protectedSite } = await ask({ type: 'list', tabId }));
  renderItems();
  renderHint();
  renderJobs();
}

async function refreshHelper() {
  helper = await ask({ type: 'helper-state' });
  renderHelper();
  renderUpdate();
  renderItems();
  renderHint();
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

async function loadJobs() {
  const { jobs: stored = [] } = await chrome.storage.session.get('jobs');
  jobs = stored;
  renderJobs();
}

async function init() {
  // ?tab=<id> lets tests open the popup as a normal tab for a specific page.
  const forced = Number(new URLSearchParams(location.search).get('tab'));
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = forced || tab?.id;
  await loadPrefs();
  repoCfg = await (await fetch(chrome.runtime.getURL('repo.json'))).json();
  isWindows = (await chrome.runtime.getPlatformInfo()).os === 'win';
  update = await ask({ type: 'update-state' });
  renderUpdate();
  await Promise.all([refreshItems(), loadJobs(), renderHistory()]);
  refreshHelper();

  $('detect').addEventListener('click', async () => {
    await ask({ type: 'force-detect', tabId });
    window.close();
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
    e.target.disabled = true;
    $('page-note').hidden = true;
    try {
      await ask({ type: 'download-page', tabId, quality: prefs.quality, cookies: prefs.cookies, subs: subsPayload() });
    } catch (err) {
      $('page-note').textContent = err.message;
      $('page-note').hidden = false;
    }
    e.target.disabled = pageRef.running;
  });
  $('clear').addEventListener('click', async () => {
    await ask({ type: 'clear-jobs' });
    await loadJobs();
  });
  $('clear-history').addEventListener('click', async () => {
    await ask({ type: 'clear-history' });
    renderHistory();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'session' && changes.jobs) {
      jobs = changes.jobs.newValue || [];
      renderJobs();
    }
    if (area === 'session' && changes[`items:${tabId}`]) refreshItems();
    if (area === 'local' && changes.history) renderHistory();
  });
  setInterval(pollDirectProgress, 800);
}

init();
