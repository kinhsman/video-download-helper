// End-to-end test: loads the unpacked extension into a throwaway Chrome profile,
// opens the fixture page, checks detection, and downloads a plain mp4, a plain HLS
// stream and an AES-128 HLS stream through the extension.
//
//   bash tests/make_fixtures.sh
//   python3 -m http.server 8791 --bind 127.0.0.1 --directory tests/fixtures &
//   node tests/e2e.mjs
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, existsSync, rmSync, mkdirSync, cpSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const BASE = 'http://127.0.0.1:8791';
const EXT_ID = (await import('node:fs')).readFileSync(join(ROOT, 'extension-id.txt'), 'utf8').trim();
const CHROME = process.env.CHROME || process.env.HOME + '/Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const PORT = 9333;
const profile = mkdtempSync(join(tmpdir(), 'vdh-profile-'));
const dlDir = join(profile, 'dl');
mkdirSync(dlDir);
mkdirSync(join(profile, 'Default'), { recursive: true });
writeFileSync(join(profile, 'Default', 'Preferences'), JSON.stringify({ download: { default_directory: dlDir, prompt_for_download: false } }));

// Test copy of the extension with nativeMessaging granted up front (the real one asks the user),
// and the helper registered inside the throwaway profile only.
const EXT = join(profile, 'ext');
cpSync(join(ROOT, 'extension'), EXT, { recursive: true });
const mf = JSON.parse(readFileSync(join(EXT, 'manifest.json'), 'utf8'));
mf.permissions.push('nativeMessaging');
mf.optional_permissions = [];
writeFileSync(join(EXT, 'manifest.json'), JSON.stringify(mf, null, 2));
mkdirSync(join(profile, 'NativeMessagingHosts'));
const wrapper = join(profile, 'run_host.sh');
const py = execFileSync('/usr/bin/env', ['which', 'python3'], { env: { ...process.env, PATH: '/opt/homebrew/bin:' + process.env.PATH } }).toString().trim();
writeFileSync(wrapper, `#!/bin/bash\nexec "${py}" "${join(ROOT, 'host', 'video_helper_host.py')}"\n`);
chmodSync(wrapper, 0o755);
writeFileSync(join(profile, 'NativeMessagingHosts', 'com.sang.video_helper.json'), JSON.stringify({
  name: 'com.sang.video_helper', description: 'test', path: wrapper, type: 'stdio',
  allowed_origins: [`chrome-extension://${EXT_ID}/`],
}));

let failed = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : '  ' + extra}`);
  if (!ok) failed++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(CHROME, [
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  `--load-extension=${EXT}`,
  '--disable-features=DisableLoadExtensionCommandLineSwitch',
  '--headless=new',
  '--no-first-run',
  '--no-default-browser-check',
  'about:blank',
], { stdio: 'ignore' });

async function cdpUrl() {
  for (let i = 0; i < 60; i++) {
    try {
      return (await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()).webSocketDebuggerUrl;
    } catch {
      await sleep(250);
    }
  }
  throw new Error('Chrome did not start');
}

class CDP {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.id = 0;
    this.pending = new Map();
    this.ready = new Promise((r) => (this.ws.onopen = r));
    this.ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? reject(new Error(m.error.message)) : resolve(m.result);
      }
    };
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
}

async function evalIn(cdp, targetId, expression) {
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
  await cdp.send('Target.detachFromTarget', { sessionId });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails));
  return r.result.value;
}

try {
  const cdp = new CDP(await cdpUrl());
  await cdp.ready;

  // 1. extension loaded with the pinned id
  let sw;
  for (let i = 0; i < 40 && !sw; i++) {
    const { targetInfos } = await cdp.send('Target.getTargets');
    sw = targetInfos.find((t) => t.type === 'service_worker' && t.url.startsWith(`chrome-extension://${EXT_ID}/`));
    if (!sw) await sleep(250);
  }
  check('extension service worker is running with the pinned id', !!sw);
  if (!sw) throw new Error('no service worker');

  // 2. open the fixture page
  const { targetId: pageId } = await cdp.send('Target.createTarget', { url: `${BASE}/index.html` });
  await sleep(300);
  // play the video so the browser requests the mp4
  const { sessionId: ps } = await cdp.send('Target.attachToTarget', { targetId: pageId, flatten: true });
  await sleep(1500);
  await cdp.send('Runtime.evaluate', { expression: "document.getElementById('v').play().catch(()=>{})", awaitPromise: true }, ps);
  await sleep(2500);

  // 3. use the popup page as the test driver (it has full extension APIs)
  const { targetId: popupId } = await cdp.send('Target.createTarget', { url: `chrome-extension://${EXT_ID}/popup.html` });
  await sleep(800);
  const pageTabId = await evalIn(cdp, popupId, `chrome.tabs.query({}).then(ts => ts.find(t => t.url.includes('/index.html') && t.url.startsWith('${BASE}'))?.id)`);
  check('found the fixture tab', typeof pageTabId === 'number');

  const call = (msg) => evalIn(cdp, popupId, `chrome.runtime.sendMessage(${JSON.stringify(msg)})`);
  const { items, streamSite } = await call({ type: 'list', tabId: pageTabId });
  console.log('detected:', items.map((i) => `${i.kind} ${i.url.replace(BASE, '')} size=${i.size} hls=${i.hls ? (i.hls.isMaster ? 'master' : 'media') + ' dur=' + Math.round(i.hls.duration) : '-'}`));
  const mp4 = items.find((i) => i.kind === 'file' && i.url.endsWith('sample.mp4'));
  const master = items.find((i) => i.kind === 'hls' && i.url.endsWith('master.m3u8'));
  const enc = items.find((i) => i.kind === 'hls' && i.url.endsWith('hls_enc/index.m3u8'));
  const hiddenVariant = items.find((i) => i.url.endsWith('/hls/index.m3u8'));
  check('detects the mp4 file', !!mp4);
  check('detects the master HLS playlist', !!master);
  check('master playlist exposes its variants and duration', master?.hls?.variants?.length === 1 && Math.round(master.hls.duration) === 20, JSON.stringify(master?.hls));
  check('hides the variant playlist that belongs to a master', !hiddenVariant);
  check('detects the encrypted HLS playlist', !!enc);

  const waitJob = async (jobId) => {
    for (let i = 0; i < 120; i++) {
      const { jobs = [] } = await evalIn(cdp, popupId, `chrome.storage.session.get('jobs')`);
      const j = jobs.find((x) => x.id === jobId);
      if (j && j.status !== 'running') return j;
      await sleep(500);
    }
    return null;
  };
  const probe = (file) => {
    try {
      return JSON.parse(execFileSync(`${process.env.HOME}/.local/bin/ffprobe`, ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,codec_name', '-of', 'json', file]).toString());
    } catch (e) {
      return null;
    }
  };

  const runs = [
    ['direct mp4', mp4, undefined],
    ['plain HLS (via master)', master, master?.hls?.variants?.[0]?.url],
    ['AES-128 HLS', enc, undefined],
  ];
  for (const [name, item, variantUrl] of runs) {
    if (!item) continue;
    const before = new Set(readdirSync(dlDir, { recursive: true }));
    const { job, error } = await call({ type: 'download', tabId: pageTabId, itemKey: item.key, variantUrl });
    if (error) {
      check(`${name}: starts`, false, error);
      continue;
    }
    const done = await waitJob(job.id);
    check(`${name}: finishes`, done?.status === 'done', JSON.stringify(done));
    await sleep(500);
    const files = readdirSync(dlDir, { recursive: true }).filter((f) => !before.has(f) && !/\.crdownload$/.test(f));
    const file = files.find((f) => /\.(mp4|ts|m4a|webm)$/.test(f));
    check(`${name}: file saved in the VideoHelper folder`, !!file && file.startsWith('VideoHelper/'), JSON.stringify(files));
    if (file) {
      const info = probe(join(dlDir, file));
      const dur = parseFloat(info?.format?.duration);
      const types = (info?.streams || []).map((s) => s.codec_type).sort().join(',');
      console.log(`   ${file}: duration=${dur} streams=${types}`);
      check(`${name}: playable, about 20 s, video and audio`, dur > 18 && dur < 22 && types === 'audio,video', JSON.stringify(info));
    }
  }

  // 4. protected-stream and failure handling at the parser level is covered in tests/test_parser.mjs
  check('detects the DASH manifest and flags a stream site', items.some((i) => i.kind === 'dash') && streamSite === true);
  check('hides tiny stream chunks served as .mp4', !items.some((i) => /dash\/(seg|chunk)/.test(i.url)), JSON.stringify(items.map((i) => i.url)));
  check('still lists the real mp4', items.some((i) => i.url.endsWith('sample.mp4')));
  const promo = items.find((i) => i.url.endsWith('dash/promo.mpd'));
  const long = items.find((i) => i.url.endsWith('dash/drm.mpd'));
  check('4 second promo manifest is marked as a short clip', promo?.minor === 'short clip', JSON.stringify(promo?.minor));
  check('45 minute stream is not hidden', long && !long.minor, JSON.stringify(long?.minor));
  const smallFile = items.find((i) => i.url.endsWith('sample.mp4'));
  const bigFile = items.find((i) => i.url.endsWith('/big.mp4'));
  check('25 MB file is the main file, 2 MB file is marked minor', bigFile && !bigFile.minor && !!smallFile?.minor, JSON.stringify([bigFile?.minor, smallFile?.minor]));
  const dmf = items.find((i) => i.url.endsWith('dash/drm.mpd'));
  check('DASH manifest with Widevine is flagged protected', /Widevine/.test(dmf?.protectedReason || ''), JSON.stringify(dmf?.dash));
  check('track files named by a manifest are folded into it', !items.some((i) => i.url.includes('drm/video_480.mp4')));
  const lone = items.find((i) => i.url.endsWith('clip_drm_480.mp4'));
  check('file named like a DRM track is flagged', !!lone?.protectedReason, JSON.stringify(lone));
  for (const it of [dmf, lone].filter(Boolean)) {
    const r = await call({ type: 'download', tabId: pageTabId, itemKey: it.key });
    check(`refuses protected item ${it.url.split('/').pop()}`, /copy-protected/.test(r.error || ''), JSON.stringify(r));
  }
  const pr = await call({ type: 'download-page', tabId: pageTabId, quality: 'best' });
  check('refuses whole-page download when the page has protected video', /copy-protected/.test(pr.error || ''), JSON.stringify(pr));
  const drm = items.find((i) => i.url.endsWith('drm/index.m3u8'));
  check('flags the DRM stream as protected', !!drm?.hls?.protected, JSON.stringify(drm?.hls));
  if (drm) {
    const r = await call({ type: 'download', tabId: pageTabId, itemKey: drm.key });
    check('refuses to download the DRM stream', !!r.error && /protected/i.test(r.error), JSON.stringify(r));
  }

  // update check
  const setOverride = (v) => evalIn(cdp, popupId, `chrome.storage.local.set({updateUrlOverride: ${JSON.stringify(v)}})`);
  await setOverride(`${BASE}/newer-version.json`);
  let up = await call({ type: 'check-update' });
  check('update check sees a newer published version', up.available === true && up.latest === '99.0.0', JSON.stringify(up));
  await setOverride(`${BASE}/does-not-exist.json`);
  up = await call({ type: 'check-update' });
  check('a failed check does not hide a known update', up.available === true && !!up.error, JSON.stringify(up));
  const applyErr = await call({ type: 'apply-update' });
  check('Update now from a development copy is refused', /development copy/.test(applyErr.error || ''), JSON.stringify(applyErr));
  await setOverride(`${BASE}/same-version.json`);
  up = await call({ type: 'check-update' });
  check('same version means no update', up.available === false, JSON.stringify(up));
  // the button itself: clicking it must show a result the user can see
  await setOverride(`${BASE}/same-version.json`);
  const uiText = await evalIn(cdp, popupId, `(async () => {
    location.reload();
    return 'reloading';
  })()`).catch(() => 'reloading');
  await sleep(1500);
  const clicked = await evalIn(cdp, popupId, `(async () => {
    const b = document.querySelector('#version button');
    b.click();
    await new Promise(r => setTimeout(r, 1500));
    return document.getElementById('version').innerText;
  })()`);
  // when an update exists, the way to apply it must sit right under the version line, not only at the top
  await setOverride(`${BASE}/newer-version.json`);
  const withUpdate = await evalIn(cdp, popupId, `(async () => {
    document.querySelector('#version button').click();
    await new Promise(r => setTimeout(r, 1500));
    return document.getElementById('version').innerText;
  })()`);
  check('Check for updates with a newer version shows what to do right there', /Update available: version 99\.0\.0/.test(withUpdate) && /(Update now|development copy|install\.sh|install\.ps1)/.test(withUpdate), JSON.stringify(withUpdate));
  await setOverride(`${BASE}/same-version.json`);
  check('Check for updates button shows a visible result', /Checked just now/.test(clicked) && /Latest published/.test(clicked), JSON.stringify(clicked));
  await setOverride(`${BASE}/newer-version.json`);
  await call({ type: 'check-update' });

  // screenshot of the populated popup
  if (process.env.SHOT) {
    const { targetId: shotId } = await cdp.send('Target.createTarget', { url: `chrome-extension://${EXT_ID}/popup.html?tab=${pageTabId}`});
    await sleep(1500);
    const { sessionId: ss } = await cdp.send('Target.attachToTarget', { targetId: shotId, flatten: true });
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 380, height: 720, deviceScaleFactor: 2, mobile: false }, ss);
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }, ss);
    writeFileSync(process.env.SHOT, Buffer.from(shot.data, 'base64'));
  }
  const hs = await call({ type: 'helper-state' });
  check('helper answers ping through Chrome native messaging', hs.state === 'ok' && !!hs.ytdlp, JSON.stringify(hs));

  // the awkward page: og:video that is an embed page, and an unlisted rendition of a master playlist
  await cdp.send('Target.createTarget', { url: `${BASE}/qa.html` });
  await sleep(3500);
  const qaTabId = await evalIn(cdp, popupId, `chrome.tabs.query({}).then(ts => ts.find(t => t.url.endsWith('/qa.html'))?.id)`);
  const qa = await call({ type: 'list', tabId: qaTabId });
  console.log('qa page:', qa.items.map((i) => i.url.replace(BASE, '')));
  check('an og:video that is an embed page is not listed as a video file', !qa.items.some((i) => i.url.includes('/embed/')), JSON.stringify(qa.items.map((i) => i.url)));
  const other = qa.items.find((i) => i.url.endsWith('qa/other.m3u8'));
  const masterSep = qa.items.find((i) => i.url.endsWith('master_sep.m3u8'));
  check('a rendition with the same length as a master is tucked away, not deleted', /part of another stream/.test(other?.minor || '') && masterSep && !masterSep.minor, JSON.stringify([other?.minor, masterSep?.minor]));

  // with the helper connected, cards must not still say it is needed
  const { targetId: cardsId } = await cdp.send('Target.createTarget', { url: `chrome-extension://${EXT_ID}/popup.html?tab=${qaTabId}` });
  await sleep(2500);
  const cardsText = await evalIn(cdp, cardsId, `document.getElementById('list').innerText`);
  check('helper connected: cards say "downloads via helper", not "needs helper"', /downloads via helper/.test(cardsText) && !/needs helper/.test(cardsText), JSON.stringify(cardsText.slice(0, 300)));

  // whole-page download on a page with no protected video
  await cdp.send('Target.createTarget', { url: `${BASE}/plain.html` });
  await sleep(1500);
  const plainTabId = await evalIn(cdp, popupId, `chrome.tabs.query({}).then(ts => ts.find(t => t.url.endsWith('/plain.html'))?.id)`);
  const { job: pj, error: pe } = await call({ type: 'download-page', tabId: plainTabId, quality: '720' });
  check('whole-page download starts via helper', !!pj, pe);
  if (pj) {
    const done = await waitJob(pj.id);
    check('whole-page download finishes', done?.status === 'done' && /\.mp4$/.test(done.filename || ''), JSON.stringify(done));
    if (done?.filename) {
      const info = probe(done.filename);
      check('whole-page file is playable', parseFloat(info?.format?.duration) > 18, JSON.stringify(info));
      try { rmSync(done.filename); } catch {}
    }
  }
} catch (e) {
  console.log('FAIL test crashed:', e.message);
  failed++;
} finally {
  chrome.kill();
  await sleep(500);
  rmSync(profile, { recursive: true, force: true });
}
console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
