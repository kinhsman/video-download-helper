// Visual QA: renders the popup for the awkward fixture page, in dark and light, with and without
// the helper enabled, and saves screenshots. Look at them, this does not assert.
//
//   bash tests/make_fixtures.sh
//   python3 -m http.server 8791 --bind 127.0.0.1 --directory tests/fixtures &
//   OUT=/tmp/qa node tests/qa.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, cpSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const BASE = 'http://127.0.0.1:8791';
const OUT = process.env.OUT || join(tmpdir(), 'vdh-qa');
mkdirSync(OUT, { recursive: true });
const EXT_ID = readFileSync(join(ROOT, 'extension-id.txt'), 'utf8').trim();
const CHROME = process.env.CHROME || process.env.HOME + '/Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function session(name, port, withHelper) {
  const profile = mkdtempSync(join(tmpdir(), 'vdh-qa-'));
  const ext = join(profile, 'ext');
  cpSync(join(ROOT, 'extension'), ext, { recursive: true });
  if (withHelper) {
    const mf = JSON.parse(readFileSync(join(ext, 'manifest.json'), 'utf8'));
    mf.permissions.push('nativeMessaging');
    mf.optional_permissions = [];
    writeFileSync(join(ext, 'manifest.json'), JSON.stringify(mf));
    mkdirSync(join(profile, 'NativeMessagingHosts'));
    const wrapper = join(profile, 'run_host.sh');
    writeFileSync(wrapper, `#!/bin/bash\nexec /opt/homebrew/bin/python3 "${join(ROOT, 'host', 'video_helper_host.py')}"\n`, { mode: 0o755 });
    writeFileSync(join(profile, 'NativeMessagingHosts', 'com.sang.video_helper.json'), JSON.stringify({
      name: 'com.sang.video_helper', description: 'qa', path: wrapper, type: 'stdio', allowed_origins: [`chrome-extension://${EXT_ID}/`],
    }));
  }
  const chrome = spawn(CHROME, [`--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, `--load-extension=${ext}`, '--disable-features=DisableLoadExtensionCommandLineSwitch', '--headless=new', '--no-first-run', 'about:blank'], { stdio: 'ignore' });
  let wsUrl;
  for (let i = 0; i < 60 && !wsUrl; i++) {
    try { wsUrl = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl; } catch { await sleep(250); }
  }
  const ws = new WebSocket(wsUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0;
  const pending = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
  };
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => { const i = ++id; pending.set(i, { resolve, reject }); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });
  for (let i = 0; i < 40; i++) {
    const { targetInfos } = await send('Target.getTargets');
    if (targetInfos.some((t) => t.type === 'service_worker' && t.url.includes(EXT_ID))) break;
    await sleep(250);
  }
  const { targetId: pageId } = await send('Target.createTarget', { url: `${BASE}/qa.html` });
  await sleep(4000);
  const { targetId: driverId } = await send('Target.createTarget', { url: `chrome-extension://${EXT_ID}/popup.html` });
  await sleep(800);
  const { sessionId: ds } = await send('Target.attachToTarget', { targetId: driverId, flatten: true });
  const tabId = (await send('Runtime.evaluate', { expression: `chrome.tabs.query({}).then(ts => ts.find(t => t.url.endsWith('/qa.html'))?.id)`, awaitPromise: true, returnByValue: true }, ds)).result.value;

  // pretend an update is waiting so the banner shows too
  await send('Runtime.evaluate', { expression: `chrome.storage.local.set({ update: { current: '0.0.1', latest: '99.0.0', available: true, notes: 'Example release notes.', checkedAt: Date.now(), repo: 'kinhsman/video-download-helper', branch: 'main' } })`, awaitPromise: true }, ds);
  for (const scheme of ['dark', 'light']) {
    const { targetId } = await send('Target.createTarget', { url: `chrome-extension://${EXT_ID}/popup.html?tab=${tabId}` });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    await send('Emulation.setDeviceMetricsOverride', { width: 380, height: 900, deviceScaleFactor: 2, mobile: false }, sessionId);
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] }, sessionId);
    await sleep(2500);
    await send('Runtime.evaluate', { expression: `document.body.style.maxHeight = 'none'; document.documentElement.scrollHeight`, returnByValue: true }, sessionId);
    const h = (await send('Runtime.evaluate', { expression: 'document.body.scrollHeight', returnByValue: true }, sessionId)).result.value;
    await send('Emulation.setDeviceMetricsOverride', { width: 380, height: Math.min(h + 20, 2400), deviceScaleFactor: 2, mobile: false }, sessionId);
    const shot = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
    writeFileSync(join(OUT, `${name}-${scheme}.png`), Buffer.from(shot.data, 'base64'));
    if (scheme === 'dark') {
      // open the first long title and shoot again
      await send('Runtime.evaluate', { expression: `document.querySelector('.more:not([hidden])')?.click()`, returnByValue: true }, sessionId);
      await sleep(300);
      const h2 = (await send('Runtime.evaluate', { expression: 'document.body.scrollHeight', returnByValue: true }, sessionId)).result.value;
      await send('Emulation.setDeviceMetricsOverride', { width: 380, height: Math.min(h2 + 20, 2400), deviceScaleFactor: 2, mobile: false }, sessionId);
      const shot2 = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
      writeFileSync(join(OUT, `${name}-${scheme}-expanded.png`), Buffer.from(shot2.data, 'base64'));
    }
    await send('Target.closeTarget', { targetId });
  }
  chrome.kill();
  await sleep(500);
  rmSync(profile, { recursive: true, force: true });
}

await session('no-helper', 9341, false);
await session('with-helper', 9342, true);
console.log('screenshots in', OUT);
process.exit(0);
