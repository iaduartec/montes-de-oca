#!/usr/bin/env node
// Captures one shared free-camera view with production tiles, explicit fallback,
// and an intentionally missing tileset. Used by the integrated map acceptance.
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
function arg(name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}
const base = arg('--base', 'http://127.0.0.1:5177');
const port = Number(arg('--cdp-port', '9235'));
const outDir = resolve(arg('--out-dir', 'output/3d-tiles-map/validation'));
mkdirSync(outDir, { recursive: true });
const profile = mkdtempSync(join(tmpdir(), `montes-3d-tiles-${port}-`));
const chrome = spawn('google-chrome', [
  '--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars',
  '--window-size=1280,720', '--enable-unsafe-swiftshader', '--use-angle=swiftshader',
  `--remote-debugging-port=${port}`, '--remote-allow-origins=*',
  `--user-data-dir=${profile}`, 'about:blank',
], { stdio: 'ignore' });

const wait = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms));
async function getJson(url, init) {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(`${url} -> HTTP ${response.status}`);
  return response.json();
}

try {
  let version;
  for (let attempt = 0; attempt < 60 && !version; attempt++) {
    try { version = await getJson(`http://127.0.0.1:${port}/json/version`); } catch { await wait(500); }
  }
  if (!version) throw new Error('Chrome CDP did not start');
  const tab = await getJson(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' });
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((resolveOpen, rejectOpen) => {
    ws.addEventListener('open', resolveOpen, { once: true });
    ws.addEventListener('error', rejectOpen, { once: true });
  });

  let id = 0;
  const pending = new Map();
  const cases = [];
  let activeCase = null;
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (activeCase) {
      if (message.method === 'Runtime.exceptionThrown') {
        activeCase.errors.push(message.params.exceptionDetails.text);
      }
      if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
        activeCase.errors.push(message.params.args.map((value) => value.value ?? value.description).join(' '));
      }
      if (message.method === 'Network.responseReceived' && message.params.response.status >= 400) {
        activeCase.failed.push({ url: message.params.response.url, status: message.params.response.status });
      }
    }
    if (message.id !== undefined && pending.has(message.id)) {
      const { resolve: resolveMessage, reject: rejectMessage } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) rejectMessage(new Error(JSON.stringify(message.error)));
      else resolveMessage(message.result ?? {});
    }
  });
  const send = (method, params = {}) => new Promise((resolveMessage, rejectMessage) => {
    const requestId = ++id;
    pending.set(requestId, { resolve: resolveMessage, reject: rejectMessage });
    ws.send(JSON.stringify({ id: requestId, method, params }));
  });
  const evaluate = async (expression) => {
    const response = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.text);
    return response.result?.value;
  };
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Network.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1280, height: 720, deviceScaleFactor: 1, mobile: false,
  });

  const common = new URLSearchParams({
    debug: '1', fog: '0',
    px: '3100', py: '95', pz: '4200', tx: '3100', ty: '0', tz: '3900',
  });
  const scenarios = [
    { name: 'tiles', params: new URLSearchParams(common), expected: 'tiles' },
    { name: 'fallback', params: new URLSearchParams([...common, ['terrain', 'fallback']]), expected: 'fallback' },
    { name: 'missing-tileset', params: new URLSearchParams([...common, ['tileset', '/terrain/3d-tiles/missing.json']]), expected: 'error' },
  ];

  for (const scenario of scenarios) {
    activeCase = { name: scenario.name, errors: [], failed: [] };
    cases.push(activeCase);
    const url = new URL('/', base);
    url.search = scenario.params.toString();
    await send('Page.navigate', { url: url.toString() });
    let state = null;
    for (let attempt = 0; attempt < 90; attempt++) {
      await wait(500);
      state = await evaluate(`({
        tiles: window.__game?.terrain3DTiles?.() ?? null,
        render: window.__game?.terrainRender?.() ?? null,
      })`).catch(() => null);
      const mode = state?.tiles?.mode ?? 'fallback';
      const status = state?.tiles?.status ?? 'disabled';
      if (scenario.expected === 'tiles' && status === 'ready' && mode === 'tiles' && state?.tiles?.visibleTiles > 1) break;
      if (scenario.expected === 'fallback' && state?.render?.enabledFallbackMeshes > 0) break;
      if (scenario.expected === 'error' && status === 'error' && state?.render?.enabledFallbackMeshes > 0) break;
    }
    await wait(scenario.expected === 'tiles' ? 8000 : 2500);
    state = await evaluate(`({
      tiles: window.__game?.terrain3DTiles?.() ?? null,
      render: window.__game?.terrainRender?.() ?? null,
      title: document.title,
      visibleText: document.body.innerText.slice(0, 1200),
    })`);
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    const imagePath = resolve(outDir, `${scenario.name}.png`);
    writeFileSync(imagePath, Buffer.from(shot.data, 'base64'));
    activeCase.state = state;
    activeCase.image = imagePath;
    if (scenario.expected === 'tiles' && (state.tiles?.mode !== 'tiles' || state.tiles?.visibleTiles < 1)) {
      throw new Error(`Tiles no se activaron: ${JSON.stringify(state.tiles)}`);
    }
    if (scenario.expected === 'fallback' && state.render?.enabledFallbackMeshes < 1) {
      throw new Error(`El modo fallback no muestra mallas: ${JSON.stringify(state.render)}`);
    }
    if (scenario.expected === 'error' && (state.tiles?.status !== 'error' || state.tiles?.groupEnabled || state.render?.enabledFallbackMeshes < 1)) {
      throw new Error(`El tileset inexistente no dejó fallback activo: ${JSON.stringify(state)}`);
    }
    if (scenario.expected !== 'error' && (activeCase.errors.length || activeCase.failed.length)) {
      throw new Error(`Fallos inesperados en ${scenario.name}: ${JSON.stringify({ errors: activeCase.errors, failed: activeCase.failed })}`);
    }
    console.log(`${scenario.name}: ${JSON.stringify({ imagePath, tiles: state.tiles, render: state.render, errors: activeCase.errors.length, failed: activeCase.failed.length })}`);
  }

  writeFileSync(resolve(outDir, 'report.json'), `${JSON.stringify({ base, viewport: '1280x720', cases }, null, 2)}\n`);
  ws.close();
} finally {
  chrome.kill('SIGKILL');
  rmSync(profile, { recursive: true, force: true });
}
