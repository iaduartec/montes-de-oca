#!/usr/bin/env node
// Browser evidence for the heading-up HUD map on desktop and mobile layouts.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const output = resolve(root, process.argv[2] ?? 'output/minimap');
const port = 5186;
const cdpPort = 9240;
const profile = `/tmp/chrome-minimap-${process.pid}`;
const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
const vite = spawn(resolve(root, 'node_modules/.bin/vite'), ['--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: root, stdio: 'ignore' });
const chrome = spawn('google-chrome', [
  '--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars', '--enable-unsafe-swiftshader', '--use-angle=swiftshader',
  `--remote-debugging-port=${cdpPort}`, '--remote-allow-origins=*', `--user-data-dir=${profile}`,
], { stdio: 'ignore' });

class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.id = 0;
    this.pending = new Map();
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
      else pending.resolve(message.result);
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolvePromise, reject) => this.pending.set(id, { resolve: resolvePromise, reject }));
  }
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  }
  async screenshot(path) {
    const result = await this.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(path, Buffer.from(result.data, 'base64'));
  }
}

async function json(url, init) {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(`${url} -> HTTP ${response.status}`);
  return response.json();
}

try {
  mkdirSync(output, { recursive: true });
  rmSync(profile, { recursive: true, force: true });
  let version = null;
  for (let i = 0; i < 80 && !version; i++) {
    try { version = await json(`http://127.0.0.1:${cdpPort}/json/version`); }
    catch { await sleep(250); }
  }
  if (!version) throw new Error('Chrome CDP no disponible');
  for (let i = 0; i < 80; i++) {
    try { await fetch(`http://127.0.0.1:${port}/`); break; }
    catch { await sleep(250); }
  }
  const tab = await json(`http://127.0.0.1:${cdpPort}/json/new?about:blank`, { method: 'PUT' });
  const socket = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((resolvePromise, reject) => {
    socket.addEventListener('open', resolvePromise, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  const cdp = new Cdp(socket);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${port}/?px=3004&py=120&pz=3958&tx=3066&ty=85&tz=3976` });
  for (let i = 0; i < 120; i++) {
    await sleep(500);
    try { if (await cdp.evaluate('!!window.__game?.perf')) break; }
    catch { /* app is still booting */ }
    if (i === 119) throw new Error('game debug API timed out');
  }
  await sleep(1200);
  const mapState = () => cdp.evaluate(`(() => { const c = document.getElementById('minimapa-canvas'); if (!c) return null; return { width: c.width, height: c.height, painted: Number(c.dataset.drawCount || 0), following: c.dataset.followingPlayer, zoom: c.dataset.zoom, rect: c.getBoundingClientRect().toJSON(), drawCalls: window.__game?.perf?.().drawCalls }; })()`);
  const beforeIdle = await mapState();
  await sleep(1200);
  const afterIdle = await mapState();
  const idleDrawDelta = afterIdle.painted - beforeIdle.painted;
  await cdp.screenshot(resolve(output, 'desktop-spawn.png'));

  const rect = afterIdle.rect;
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cx, y: cy, button: 'left', buttons: 1, clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cx + 18, y: cy + 12, button: 'left', buttons: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cx + 18, y: cy + 12, button: 'left', buttons: 0 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: cx, y: cy, deltaY: -140, deltaX: 0 });
  await sleep(350);
  const panned = await mapState();
  await cdp.evaluate("document.getElementById('minimapa-recenter').click()");
  await sleep(250);
  const recentered = await mapState();

  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 430, height: 850, deviceScaleFactor: 1, mobile: true });
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await sleep(500);
  const mobile = await mapState();
  await cdp.screenshot(resolve(output, 'mobile-spawn.png'));
  const report = {
    generatedBy: 'scripts/ui/capture_minimap.mjs',
    idleDrawDelta1200ms: idleDrawDelta,
    maxExpectedDrawDelta: 12,
    desktop: afterIdle,
    afterPanAndZoom: panned,
    afterRecenter: recentered,
    mobile,
    browser: 'Chromium + SwiftShader; not a physical mobile GPU measurement',
  };
  if (idleDrawDelta > 12) throw new Error(`minimapa excedió 10 Hz: ${idleDrawDelta} dibujados/1,2 s`);
  if (panned.following !== 'false' || recentered.following !== 'true') throw new Error('pan/recentrado no cambió el estado de seguimiento');
  if (panned.zoom === afterIdle.zoom) throw new Error('zoom con rueda no cambió');
  if (mobile.rect.width < 120 || mobile.rect.height < 120) throw new Error(`tamaño móvil inesperado ${mobile.rect.width}x${mobile.rect.height}`);
  writeFileSync(resolve(output, 'capture-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  socket.close();
  console.log(JSON.stringify(report, null, 2));
} finally {
  chrome.kill('SIGTERM');
  vite.kill('SIGTERM');
  rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
