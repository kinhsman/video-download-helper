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
let jobs = [];
let prefs = { quality: 'best', cookies: false };

async function loadPrefs() {
  const { prefs: p } = await chrome.storage.local.get('prefs');
  prefs = { ...prefs, ...p };
  $('page-quality').value = prefs.quality;
  $('cookies').checked = prefs.cookies;
}
const savePrefs = () => chrome.storage.local.set({ prefs });

function chip(text, kind = '') {
  return el('span', { class: `chip ${kind}` }, text);
}

function renderItems() {
  const box = $('list');
  box.replaceChildren();
  if (!items.length) {
    box.append(el('div', { class: 'empty' }, 'No videos found yet. Press play on the video, then reopen this. If nothing shows, try Force detect.'));
    return;
  }
  const shown = items.filter((it) => showMinor || !it.minor);
  for (const it of shown) {
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
        if (hls.duration) chips.push(chip(fmtDur(hls.duration)));
        if (hls.live) chips.push(chip('live', 'warn'));
        if (hls.protected) chips.push(chip(`protected: ${hls.protected}`, 'bad'));
        if (hls.error && !hls.variants.length) chips.push(chip('could not read playlist', 'warn'));
        if (hls.variants.length) {
          select = el(
            'select',
            { 'aria-label': 'Quality' },
            hls.variants.map((v) => {
              const est = v.estBytes ? ` · ~${fmtBytes(v.estBytes)}` : '';
              const sep = v.separateAudio ? ' · needs helper' : '';
              return el('option', { value: v.url }, `${v.label}${est}${sep}`);
            }),
          );
        } else if (hls.duration) {
          // single media playlist: no estimate without bandwidth
        }
      }
    } else if (it.kind === 'dash') {
      chips.push(chip('DASH stream'));
      if (it.dash?.duration) chips.push(chip(fmtDur(it.dash.duration)));
      if (it.protectedReason) chips.push(chip(`protected: ${it.protectedReason}`, 'bad'));
      else chips.push(chip('needs helper', 'warn'));
    }

    const blocked = it.protectedReason || (it.kind === 'dash' && helper.state !== 'ok');
    const btn = el('button', {
      disabled: !!blocked,
      onclick: async (e) => {
        e.target.disabled = true;
        try {
          await ask({ type: 'download', tabId, itemKey: it.key, variantUrl: select?.value, quality: prefs.quality, cookies: prefs.cookies });
        } catch (err) {
          showError(err.message);
        }
        e.target.disabled = false;
      },
    }, 'Download');

    if (it.minor) chips.push(chip(it.minor, 'warn'));
    const name = it.title || it.pageUrl || 'Video';
    box.append(
      el('div', { class: 'card' },
        el('div', { class: 'name', title: name }, name),
        el('div', { class: 'url', title: it.url }, it.url),
        el('div', { class: 'chips' }, chips),
        el('div', { class: 'row' }, select, !select && el('span', { style: 'flex:1' }), btn),
      ),
    );
  }
  appendMinorToggle();
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

function jobRow(j, withProgress) {
  const pct = j.status === 'done' ? 100 : j.percent || 0;
  const label = { running: `${pct}%`, done: 'Done', error: 'Failed', canceled: 'Canceled' }[j.status] || j.status;
  return el('div', { class: `job ${j.status}`, 'data-id': j.id },
    el('div', { class: 'top' },
      el('div', { class: 'title', title: j.title }, j.title),
      j.status === 'running'
        ? el('button', { class: 'link', onclick: () => ask({ type: 'cancel', jobId: j.id }) }, 'Cancel')
        : el('span', { class: 'detail' }, label),
    ),
    withProgress && j.status === 'running' && el('progress', { max: 100, value: pct }),
    j.status === 'done' && j.filename
      ? el('div', { class: 'detail' },
        `${j.detail || 'Saved'}: ${tidyPath(j.filename)} `,
        el('button', {
          class: 'link',
          onclick: async (e) => {
            try {
              await ask({ type: 'reveal', jobId: j.id });
            } catch (err) {
              e.target.replaceWith(el('span', { class: 'detail' }, err.message));
            }
          },
        }, 'Show in folder'))
      : el('div', { class: 'detail' }, j.detail || ''),
  );
}

// "/Users/me/Downloads/VideoHelper/x.mp4" -> "Downloads/VideoHelper/x.mp4"
function tidyPath(path) {
  const m = path.match(/(Downloads[\\/].*)$/);
  return m ? m[1] : path.split(/[\\/]/).pop();
}

function renderJobs() {
  const sorted = [...jobs].sort((a, b) => b.startedAt - a.startedAt);
  $('jobs-section').hidden = !sorted.length;
  $('jobs').replaceChildren(...sorted.slice(0, 6).map((j) => jobRow(j, true)));
}

async function renderHistory() {
  const { history = [] } = await chrome.storage.local.get('history');
  $('history-section').hidden = !history.length;
  $('history').replaceChildren(
    ...history.slice(0, 15).map((h) => el('div', { class: `job ${h.status}` },
      el('div', { class: 'top' }, el('div', { class: 'title', title: h.filename || h.title }, h.title), el('span', { class: 'detail' }, h.status === 'done' ? 'Done' : 'Failed')),
      el('div', { class: 'detail' }, h.status === 'done' ? h.filename.split('/').pop() : h.detail),
    )),
  );
}

const installCmd = () => {
  const base = `https://raw.githubusercontent.com/${repoCfg.repo}/${repoCfg.branch}`;
  return isWindows ? `irm ${base}/install.ps1 | iex` : `curl -fsSL ${base}/install.sh | bash`;
};

function renderUpdate() {
  const box = $('update');
  box.replaceChildren();
  const current = chrome.runtime.getManifest().version;
  $('version').replaceChildren(
    `Version ${current} `,
    el('button', {
      class: 'link',
      onclick: async (e) => {
        e.target.textContent = 'Checking...';
        try {
          update = await ask({ type: 'check-update' });
        } catch {}
        renderUpdate();
      },
    }, 'Check for updates'),
    update?.error ? ` (last check failed: ${update.error})` : update?.checkedAt && !update.available ? ' (up to date)' : '',
  );
  if (!update?.available) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  box.append(el('p', {}, `Update available: version ${update.latest} (you have ${current}).${update.notes ? ' ' + update.notes : ''}`));
  if (helper.state === 'ok' && helper.installed) {
    const status = el('div', { class: 'detail' });
    box.append(
      el('div', { class: 'row' }, el('button', {
        onclick: async (e) => {
          e.target.disabled = true;
          e.target.textContent = 'Updating...';
          try {
            await ask({ type: 'apply-update' });
            e.target.textContent = 'Updated, reloading...';
            setTimeout(() => chrome.runtime.reload(), 700);
          } catch (err) {
            e.target.disabled = false;
            e.target.textContent = 'Update now';
            status.textContent = err.message;
          }
        },
      }, 'Update now')),
      status,
    );
  } else {
    box.append(
      el('p', {}, `Run this in ${isWindows ? 'PowerShell' : 'Terminal'}, then press the reload arrow on this extension in chrome://extensions:`),
      el('code', {}, installCmd()),
    );
  }
}

function renderHelper() {
  const f = $('helper');
  f.replaceChildren();
  $('page-dl').hidden = helper.state !== 'ok';
  if (helper.state === 'ok') {
    f.append(`Helper connected. yt-dlp ${helper.ytdlp || '?'}${helper.ffmpeg ? ', ffmpeg ok' : ', ffmpeg missing'}.`);
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

function showError(message) {
  const jobsBox = $('jobs');
  $('jobs-section').hidden = false;
  jobsBox.prepend(el('div', { class: 'job error' }, el('div', { class: 'title' }, 'Could not start'), el('div', { class: 'detail' }, message)));
}

async function refreshItems() {
  ({ items, streamSite, protectedSite } = await ask({ type: 'list', tabId }));
  renderItems();
  renderHint();
}

async function refreshHelper() {
  helper = await ask({ type: 'helper-state' });
  renderHelper();
  renderUpdate();
  renderItems();
  renderHint();
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
  $('cookies').addEventListener('change', (e) => {
    prefs.cookies = e.target.checked;
    savePrefs();
  });
  $('page-go').addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      await ask({ type: 'download-page', tabId, quality: prefs.quality, cookies: prefs.cookies });
    } catch (err) {
      showError(err.message);
    }
    e.target.disabled = false;
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
