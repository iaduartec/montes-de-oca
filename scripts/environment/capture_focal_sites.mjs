#!/usr/bin/env node
// Fixed-view baseline and comparison captures for church/plaza and Alba dam.
// No map imagery is copied; game screenshots contain only the local game scene.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const args = process.argv.slice(2);
function arg(name, fallback) {
  const at = args.indexOf(name);
  return at >= 0 && args[at + 1] ? args[at + 1] : fallback;
}

const port = Number(arg('--port', '5182'));
const cdpPort = Number(arg('--cdp-port', '9228'));
const base = arg('--base', `http://127.0.0.1:${port}`);
const landmarkMode = arg('--landmarks', '1');
const vehicle = arg('--vehicle', '');
const viewFilter = arg('--view', '');
const outDir = resolve(root, arg('--out-dir', 'output/focal-sites-before'));
const profile = `/tmp/chrome-cdp-profile-focal-sites-${process.pid}`;
const chromeBin = arg('--chrome', 'google-chrome');
const views = [
  {
    id: 'church-facade',
    title: 'Iglesia de Santiago Apóstol',
    target: { x: 3067.357, z: 3976.874 },
    lookTarget: { x: 3067.357, z: 3983.5 },
    cameraOffset: { x: 0, z: 42 },
    cameraHeight: 21,
    targetHeight: 4.5,
  },
  {
    id: 'plaza',
    title: 'La Plaza',
    target: { x: 3063.04, z: 4012.346 },
    lookTarget: { x: 3084.0, z: 4004.5 },
    cameraOffset: { x: 0, z: 14 },
    cameraHeight: 20,
    targetHeight: 1.5,
  },
  {
    id: 'dam',
    title: 'Presa de Alba',
    target: { x: 2434.565, z: 1523.295 },
    cameraOffset: { x: 70, z: 75 },
    cameraHeight: 35,
    targetHeight: 5,
  },
  {
    id: 'vehicle-demo',
    title: 'Vehículo en spawn',
    target: null,
  },
];
const selectedViews = viewFilter ? views.filter((view) => view.id === viewFilter) : views;
if (selectedViews.length === 0) throw new Error(`unknown view: ${viewFilter}`);

const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
async function getJson(url, init) {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(`${url} -> HTTP ${response.status}`);
  return response.json();
}

class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 0;
    this.pending = new Map();
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id === undefined) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
      else pending.resolve(message.result);
    });
  }

  send(method, params = {}) {
    const id = ++this.nextId;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolvePromise, reject) => this.pending.set(id, { resolve: resolvePromise, reject }));
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  }

  async screenshot(file) {
    const result = await this.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(file, Buffer.from(result.data, 'base64'));
  }
}

async function waitForGame(cdp) {
  for (let attempt = 0; attempt < 180; attempt++) {
    await sleep(1000);
    try {
      if (await cdp.evaluate('!!window.__game?.perf')) return;
    } catch {
      // The page is still loading.
    }
  }
  throw new Error('the game debug API did not become ready');
}

async function main() {
  mkdirSync(outDir, { recursive: true });
  rmSync(profile, { recursive: true, force: true });
  const vite = spawn(resolve(root, 'node_modules/.bin/vite'), ['--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
    cwd: root,
    stdio: 'ignore',
  });
  const chrome = spawn(chromeBin, [
    '--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars',
    '--window-size=1280,720', '--enable-unsafe-swiftshader', '--use-angle=swiftshader',
    `--remote-debugging-port=${cdpPort}`, '--remote-allow-origins=*', `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: 'ignore' });

  try {
    let version = null;
    for (let attempt = 0; attempt < 60 && !version; attempt++) {
      try {
        version = await getJson(`http://127.0.0.1:${cdpPort}/json/version`);
      } catch {
        await sleep(500);
      }
    }
    if (!version) throw new Error('Chrome did not open its debugging port');
    for (let attempt = 0; attempt < 60; attempt++) {
      try {
        await fetch(`${base}/`);
        break;
      } catch {
        await sleep(500);
      }
    }

    const tab = await getJson(`http://127.0.0.1:${cdpPort}/json/new?about:blank`, { method: 'PUT' });
    const socket = new WebSocket(tab.webSocketDebuggerUrl);
    await new Promise((resolvePromise, reject) => {
      socket.addEventListener('open', resolvePromise, { once: true });
      socket.addEventListener('error', reject, { once: true });
    });
    const cdp = new Cdp(socket);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });

    // Read terrain elevations first, then place all camera targets relative to the
    // actual IGN surface. This avoids mixing absolute elevations with world Y.
    await cdp.send('Page.navigate', { url: `${base}/?drape=0&water=0&pueblo=0&vegetation=0` });
    await waitForGame(cdp);
    const reportPath = resolve(outDir, 'capture-report.json');
    const previousViews = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, 'utf8')).views ?? [] : [];
    const report = { generatedBy: 'scripts/environment/capture_focal_sites.mjs', base, capturedAt: new Date().toISOString(), views: [] };
    for (const view of selectedViews) {
      if (view.id === 'vehicle-demo') {
        if (!vehicle) throw new Error('--vehicle is required with --view vehicle-demo');
        const url = `${base}/?player=0&vehicle=${encodeURIComponent(vehicle)}`;
        console.log(`[focal-sites] ${view.id}: ${url}`);
        await cdp.send('Page.navigate', { url });
        await waitForGame(cdp);
        const vehiclePose = await cdp.evaluate('window.__game.vehicle?.telemetry() ?? null');
        if (!vehiclePose) throw new Error(`vehicle telemetry unavailable for ${vehicle}`);
        await sleep(3500);
        const result = {
          id: view.id,
          title: `${view.title} (${vehicle})`,
          vehicle,
          camera: 'vehicle chase camera, player disabled',
          pose: { x: vehiclePose.x, y: vehiclePose.y, z: vehiclePose.z },
          perf: await cdp.evaluate('window.__game.perf()'),
          screenshot: `vehicle-${vehicle}.png`,
        };
        await cdp.screenshot(resolve(outDir, result.screenshot));
        report.views.push(result);
        continue;
      }
      const groundY = await cdp.evaluate(`window.__game.terrainHeightAt(${view.target.x}, ${view.target.z})`);
      const lookTarget = view.lookTarget ?? view.target;
      const camera = {
        px: lookTarget.x + view.cameraOffset.x,
        py: groundY + view.cameraHeight,
        pz: lookTarget.z + view.cameraOffset.z,
        tx: lookTarget.x,
        ty: groundY + view.targetHeight,
        tz: lookTarget.z,
      };
      const query = new URLSearchParams(Object.entries(camera).map(([key, value]) => [key, String(value)]));
      if (landmarkMode === '0') query.set('landmarks', '0');
      if (vehicle) query.set('vehicle', vehicle);
      const url = `${base}/?${query.toString()}`;
      console.log(`[focal-sites] ${view.id}: ${url}`);
      await cdp.send('Page.navigate', { url });
      await waitForGame(cdp);
      await sleep(3500);
      const result = {
        id: view.id,
        title: view.title,
        target: view.target,
        groundY,
        camera,
        landmarks: landmarkMode !== '0',
        perf: await cdp.evaluate('window.__game.perf()'),
        water: await cdp.evaluate('window.__game.water?.stats() ?? null'),
        minimap: await cdp.evaluate(`(() => { const c = document.getElementById('minimapa-canvas'); if (!c) return null; const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let opaque = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) opaque++; return { width: c.width, height: c.height, paintedPixels: opaque }; })()`),
        screenshot: `${view.id}.png`,
      };
      await cdp.screenshot(resolve(outDir, result.screenshot));
      report.views.push(result);
    }
    const viewsByKey = new Map(previousViews.map((view) => [`${view.id}:${view.vehicle ?? ''}`, view]));
    for (const view of report.views) viewsByKey.set(`${view.id}:${view.vehicle ?? ''}`, view);
    report.views = [...viewsByKey.values()];
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    socket.close();
    console.log(`[focal-sites] saved ${report.views.length} fixed-view screenshots to ${outDir}`);
  } finally {
    chrome.kill('SIGTERM');
    vite.kill('SIGTERM');
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

main().catch((error) => {
  console.error(`[focal-sites] ${error instanceof Error ? error.stack : String(error)}`);
  process.exitCode = 1;
});
