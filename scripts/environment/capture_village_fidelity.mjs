#!/usr/bin/env node
// Same-camera baseline/after captures from the actual game entry point.
// Street/landmark cameras are diagnostic free-camera placements; playable.png
// retains the native player camera and actor/NPC state.
// Usage:
//   node scripts/environment/capture_village_fidelity.mjs --phase before --base http://127.0.0.1:5174
//   node scripts/environment/capture_village_fidelity.mjs --phase after --base http://127.0.0.1:5174
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const args = process.argv.slice(2);
function arg(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
}

const phase = arg('--phase', 'before');
if (!['before', 'after'].includes(phase)) throw new Error('--phase must be before or after');
const base = arg('--base', 'http://127.0.0.1:5174');
const outDir = resolve(root, arg('--out-dir', `outputs/village-fidelity-20261004/${phase}`));
const cdpPort = Number(arg('--cdp-port', '9237'));
const chromeBin = arg('--chrome', 'google-chrome');
const width = 1280;
const height = 720;
const quality = 'HIGH';
const profile = `/tmp/chrome-village-fidelity-${process.pid}-${cdpPort}`;
const manifestPath = resolve(root, arg('--manifest', 'outputs/village-fidelity-20261004/before/camera-manifest.json'));

// World positions (X east, Z north). Each free camera looks along a real street
// or at a known focal site; heights are sampled above the local DEM only during
// baseline creation and become immutable camera coordinates in the manifest.
const viewSpecs = [
  { name: 'calle_mayor_1', target: { x: 3060, z: 3992 }, offset: { x: -21, z: -14 }, cameraHeight: 6, targetHeight: 1.5 },
  { name: 'calle_mayor_2', target: { x: 3075, z: 3952 }, offset: { x: -22, z: -9 }, cameraHeight: 5.5, targetHeight: 1.5 },
  { name: 'plaza', target: { x: 3060, z: 3963 }, offset: { x: -1, z: 16 }, cameraHeight: 20, targetHeight: 1.5 },
  { name: 'iglesia', target: { x: 3067.357, z: 3976.874 }, offset: { x: 0, z: 42 }, cameraHeight: 21, targetHeight: 4.5 },
  { name: 'entrada_norte', target: { x: 3063, z: 4058 }, offset: { x: -14, z: -30 }, cameraHeight: 7, targetHeight: 1.5 },
  { name: 'entrada_sur', target: { x: 3080, z: 3900 }, offset: { x: 12, z: 30 }, cameraHeight: 8, targetHeight: 1.5 },
  { name: 'pilot_houses', target: { x: 3090, z: 3975 }, offset: { x: -14, z: -16 }, cameraHeight: 7, targetHeight: 1.5 },
  { name: 'road', target: { x: 3087.53, z: 3935.05 }, offset: { x: 0, z: -24 }, cameraHeight: 5.5, targetHeight: 1.5 },
  { name: 'vehicle', target: { x: 3087.53, z: 3935.05 }, offset: { x: -12, z: -9 }, cameraHeight: 6.5, targetHeight: 1.2 },
  { name: 'track', target: { x: 3087, z: 3780 }, offset: { x: 14, z: 24 }, cameraHeight: 8, targetHeight: 1.5 },
  { name: 'forest', target: { x: 3270, z: 4140 }, offset: { x: -45, z: -54 }, cameraHeight: 30, targetHeight: 3 },
  { name: 'river', target: { x: 2820, z: 2122 }, offset: { x: -28, z: -18 }, cameraHeight: 17, targetHeight: 2 },
  { name: 'aerial', target: { x: 3070, z: 3995 }, offset: { x: 75, z: -85 }, cameraHeight: 180, targetHeight: 0 },
  { name: 'house_310174514', target: { x: 3050.902, z: 3902.772 }, offset: { x: 0, z: -12 }, cameraHeight: 25, targetHeight: 8, buildingId: 310174514 },
  { name: 'house_818885706', target: { x: 3110.194, z: 3992.493 }, offset: { x: 0, z: -12 }, cameraHeight: 25, targetHeight: 8, buildingId: 818885706 },
  { name: 'house_818885708', target: { x: 3121.82, z: 3969.491 }, offset: { x: 0, z: -12 }, cameraHeight: 25, targetHeight: 8, buildingId: 818885708 },
  { name: 'house_474364245', target: { x: 3054.489, z: 3838.234 }, offset: { x: 0, z: -12 }, cameraHeight: 25, targetHeight: 8, buildingId: 474364245 },
  { name: 'house_474649085', target: { x: 3052.797, z: 3828.178 }, offset: { x: 0, z: -12 }, cameraHeight: 25, targetHeight: 8, buildingId: 474649085 },
  { name: 'house_672017718', target: { x: 3002.991, z: 3955.656 }, offset: { x: 0, z: -12 }, cameraHeight: 25, targetHeight: 8, buildingId: 672017718, title: 'Antiguo Hospital' },
];
const requestedViews = arg('--views', '').split(',').filter(Boolean);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function getJson(url, init) {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(`${url} -> HTTP ${response.status}`);
  return response.json();
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 0;
    this.pending = new Map();
    this.errors = [];
    this.listeners = new Map();
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      const listeners = this.listeners.get(message.method);
      if (listeners) {
        this.listeners.delete(message.method);
        for (const listener of listeners) listener(message.params ?? {});
      }
      if (message.method === 'Runtime.exceptionThrown') {
        const details = message.params.exceptionDetails;
        this.errors.push(JSON.stringify({ text: details.text, exception: details.exception?.description, url: details.url,
          line: details.lineNumber, column: details.columnNumber, stack: details.stackTrace?.callFrames?.slice(0, 5) }));
      }
      if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') this.errors.push(message.params.args.map((a) => a.value ?? a.description).join(' '));
      if (message.id === undefined || !this.pending.has(message.id)) return;
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
      else pending.resolve(message.result);
    });
    ws.addEventListener('close', () => {
      for (const [id, pending] of this.pending) {
        clearTimeout(pending.timer);
        pending.reject(new Error(`CDP connection closed while waiting for request ${id}`));
      }
      this.pending.clear();
    });
  }
  send(method, params = {}) {
    const id = ++this.nextId;
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timed out after 30000 ms`));
      }, 30000);
      this.pending.set(id, { resolve: resolvePromise, reject, timer });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }
  waitForEvent(method, timeoutMs = 45000) {
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        const waiting = this.listeners.get(method);
        waiting?.delete(onEvent);
        if (waiting?.size === 0) this.listeners.delete(method);
        reject(new Error(`timed out waiting for ${method}`));
      }, timeoutMs);
      const onEvent = (params) => { clearTimeout(timer); resolvePromise(params); };
      const waiting = this.listeners.get(method) ?? new Set();
      waiting.add(onEvent);
      this.listeners.set(method, waiting);
    });
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

async function navigateAndWait(cdp, url) {
  const loaded = cdp.waitForEvent('Page.loadEventFired');
  const navigation = await cdp.send('Page.navigate', { url });
  if (navigation.errorText) throw new Error(`navigation to ${url} failed: ${navigation.errorText}`);
  await loaded;
  for (let attempt = 0; attempt < 30; attempt++) {
    const ready = await cdp.evaluate(`location.href === ${JSON.stringify(url)} && document.readyState === 'complete'`);
    if (ready) return;
    await sleep(100);
  }
  throw new Error(`page did not finish loading at ${url}`);
}

async function waitGame(cdp, expectedUrl) {
  for (let attempt = 0; attempt < 180; attempt++) {
    await sleep(1000);
    try {
      if (await cdp.evaluate(`location.href === ${JSON.stringify(expectedUrl)} && document.readyState === 'complete' && !!window.__game?.perf`)) return;
    } catch { /* page is booting */ }
  }
  throw new Error(`actual game did not become ready at ${expectedUrl}`);
}

async function waitTerrain(cdp) {
  const started = Date.now();
  while (Date.now() - started < 45000) {
    const settled = await cdp.evaluate('(()=>{const t=window.__game.runtime?.().terrain;return !!t && t.residentGpuMeshes > 0 && t.queuedTiles===0 && t.loadingTiles===0;})()');
    if (settled) return;
    await sleep(500);
  }
  throw new Error('terrain residency did not settle');
}

async function waitRenderedScene(cdp, { requireNpc = false } = {}) {
  let consecutive = 0;
  let lastState = null;
  for (let attempt = 0; attempt < 120; attempt++) {
    lastState = await cdp.evaluate(`(()=>{const g=window.__game;const p=g?.perf?.();const r=g?.runtime?.();const n=g?.villageNpcs?.stats?.();return {href:location.href,readyState:document.readyState,perf:p??null,terrain:r?.terrain??null,renderSize:r?{width:r.renderWidth,height:r.renderHeight}:null,npc:n??null};})()`);
    const ready = lastState?.perf?.drawCalls > 0 && lastState.perf.triangles > 0 && lastState.perf.activeMeshes > 0 && lastState.renderSize?.width > 0 && lastState.renderSize?.height > 0 && !!lastState.terrain && (!requireNpc || ((lastState.npc?.characters ?? 0) > 0 && (lastState.npc?.meshes ?? 0) > 0));
    consecutive = ready ? consecutive + 1 : 0;
    if (consecutive >= 3) return;
    await sleep(500);
  }
  throw new Error(`rendered game scene did not become ready${requireNpc ? ' with village NPCs' : ''}; last state=${JSON.stringify(lastState)}; browser errors=${JSON.stringify(cdp.errors)}`);
}

function cameraQuery(camera, spawn = null) {
  const query = new URLSearchParams({ quality, px: camera.position.x, py: camera.position.y, pz: camera.position.z,
    tx: camera.target.x, ty: camera.target.y, tz: camera.target.z });
  if (spawn) {
    query.set('vx', String(spawn.x));
    query.set('vz', String(spawn.z));
    query.set('vyaw', String(spawn.yaw));
  }
  return `${base}/?${query}`;
}

async function main() {
  mkdirSync(outDir, { recursive: true });
  const chrome = spawn(chromeBin, ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars',
    `--window-size=${width},${height}`, '--enable-unsafe-swiftshader', '--use-angle=swiftshader',
    `--remote-debugging-port=${cdpPort}`, '--remote-allow-origins=*', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
  let cdp;
  try {
    let version = null;
    for (let i = 0; i < 60 && !version; i++) {
      try { version = await getJson(`http://127.0.0.1:${cdpPort}/json/version`); } catch { await sleep(500); }
    }
    if (!version) throw new Error('Chrome did not open its unique CDP port');
    const tab = await getJson(`http://127.0.0.1:${cdpPort}/json/new?about:blank`, { method: 'PUT' });
    const ws = new WebSocket(tab.webSocketDebuggerUrl);
    await new Promise((ok, fail) => { ws.addEventListener('open', ok, { once: true }); ws.addEventListener('error', fail, { once: true }); });
    cdp = new Cdp(ws);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Page.bringToFront');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });

    let manifest;
    if (phase === 'before') {
      const url = `${base}/?quality=${quality}`;
      await navigateAndWait(cdp, url);
      await waitGame(cdp, url);
      await waitTerrain(cdp);
      const views = [];
      for (const spec of viewSpecs) {
        const groundY = await cdp.evaluate(`window.__game.terrainHeightAt(${spec.target.x},${spec.target.z})`);
        const camera = { position: { x: spec.target.x + spec.offset.x, y: groundY + spec.cameraHeight, z: spec.target.z + spec.offset.z },
          target: { x: spec.target.x, y: groundY + spec.targetHeight, z: spec.target.z }, fovRadians: 0.8, preset: 'diagnostic-free-camera' };
        views.push({ ...spec, groundY, camera });
      }
      const actorTarget = { x: 3063.04, z: 4012.346 };
      const actorGroundY = await cdp.evaluate(`window.__game.terrainHeightAt(${actorTarget.x},${actorTarget.z})`);
      const actorCamera = { position: { x: actorTarget.x - 13, y: actorGroundY + 5.2, z: actorTarget.z - 11 },
        target: { x: actorTarget.x, y: actorGroundY + 1.25, z: actorTarget.z }, fovRadians: 0.8, preset: 'diagnostic-actor-frame' };
      manifest = { generatedAt: new Date().toISOString(), generatedFrom: 'actual game, window.__game.terrainHeightAt', baseBaselineHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), quality, viewport: { width, height, deviceScaleFactor: 1 }, fovRadians: 0.8, fovSource: 'UniversalCamera default from Babylon.js 8.56.2; unchanged in src/runtime/rendering-runtime.ts', views,
        playable: { name: 'spawn', url: `${base}/?quality=${quality}`, camera: 'native player chase camera; unmodified playable spawn' },
        actorDiagnostic: { name: 'character_npc', groundY: actorGroundY, camera: actorCamera,
          explanation: 'Diagnostic free camera showing real village NPCs. Free-camera mode does not instantiate the playable player or vehicle; use spawn.png for playable actors.' } };
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    } else {
      if (!existsSync(manifestPath)) throw new Error(`after phase requires baseline manifest: ${manifestPath}`);
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      if (manifest.viewport.width !== width || manifest.viewport.height !== height || manifest.quality !== quality) throw new Error('baseline manifest viewport/quality mismatch');
    }

    const selectedViews = requestedViews.length ? manifest.views.filter((view) => requestedViews.includes(view.name)) : manifest.views;
    const specialRequested = requestedViews.filter((name) => ['spawn', 'playable', 'character_npc'].includes(name));
    const unknownViews = requestedViews.filter((name) => !selectedViews.some((view) => view.name === name) && !specialRequested.includes(name));
    if (unknownViews.length) throw new Error(`unknown requested view(s): ${unknownViews.join(', ')}`);

    const report = { phase, base, capturedAt: new Date().toISOString(), cameraManifest: manifestPath, quality,
      viewport: { width, height, deviceScaleFactor: 1 }, backend: 'Chrome headless SwiftShader; FPS/frame time are not target-GPU evidence', views: [], errors: [] };
    for (const view of selectedViews) {
      console.log(`[village-fidelity] ${phase} ${view.name}`);
      const url = cameraQuery(view.camera);
      await navigateAndWait(cdp, url);
      await waitGame(cdp, url);
      await waitTerrain(cdp);
      await waitRenderedScene(cdp);
      await sleep(1600);
      const metrics = await cdp.evaluate(`(()=>{const g=window.__game;const canvas=document.getElementById('render-canvas');const gl=canvas?.getContext('webgl2')??canvas?.getContext('webgl');const ext=gl?.getExtension('WEBGL_debug_renderer_info');return {perf:g.perf(),runtime:g.runtime?.()??null,renderer:ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):null,textures:g.runtime?.().textures??null,vehicle:g.vehicle?.telemetry?.()??null,player:g.player?.telemetry?.()??null,npc:g.villageNpcs?.stats?.()??null};})()`);
      const record = { captureOrigin: { base, capturedAt: new Date().toISOString() }, name: view.name, camera: view.camera, groundY: view.groundY, diagnosticPlacement: true, screenshot: `${view.name}.png`, ...metrics };
      report.views.push(record);
      await cdp.screenshot(resolve(outDir, record.screenshot));
    }

    if (!requestedViews.length || requestedViews.includes('playable') || requestedViews.includes('spawn')) {
      console.log(`[village-fidelity] ${phase} playable spawn`);
      const playableUrl = `${base}/?quality=${encodeURIComponent(quality)}`;
      await navigateAndWait(cdp, playableUrl);
      await waitGame(cdp, playableUrl);
      await waitTerrain(cdp);
      await waitRenderedScene(cdp);
      await sleep(2200);
      const playableMetrics = await cdp.evaluate(`(()=>{const g=window.__game;const canvas=document.getElementById('render-canvas');const gl=canvas?.getContext('webgl2')??canvas?.getContext('webgl');const ext=gl?.getExtension('WEBGL_debug_renderer_info');return {perf:g.perf(),runtime:g.runtime?.()??null,renderer:ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):null,textures:g.runtime?.().textures??null,vehicle:g.vehicle?.telemetry?.()??null,player:g.player?.telemetry?.()??null,npc:g.villageNpcs?.stats?.()??null};})()`);
      report.views.push({ captureOrigin: { base, capturedAt: new Date().toISOString() }, name: 'spawn', camera: manifest.playable.camera, diagnosticPlacement: false, screenshot: 'spawn.png', ...playableMetrics });
      await cdp.screenshot(resolve(outDir, 'playable.png'));
      writeFileSync(resolve(outDir, 'spawn.png'), readFileSync(resolve(outDir, 'playable.png')));
    }

    const actor = manifest.actorDiagnostic;
    if (!requestedViews.length || requestedViews.includes('character_npc')) {
      const url = cameraQuery(actor.camera, actor.spawn);
      await navigateAndWait(cdp, url);
      await waitGame(cdp, url);
      await waitTerrain(cdp);
      await waitRenderedScene(cdp, { requireNpc: true });
      await sleep(1900);
      const actorMetrics = await cdp.evaluate(`(()=>{const g=window.__game;const canvas=document.getElementById('render-canvas');const gl=canvas?.getContext('webgl2')??canvas?.getContext('webgl');const ext=gl?.getExtension('WEBGL_debug_renderer_info');return {perf:g.perf(),runtime:g.runtime?.()??null,renderer:ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):null,textures:g.runtime?.().textures??null,vehicle:g.vehicle?.telemetry?.()??null,player:g.player?.telemetry?.()??null,npc:g.villageNpcs?.stats?.()??null};})()`);
      report.views.push({ captureOrigin: { base, capturedAt: new Date().toISOString() }, name: 'character_npc', camera: actor.camera, diagnosticPlacement: true, placement: actor.explanation, screenshot: 'character_npc.png', ...actorMetrics });
      await cdp.screenshot(resolve(outDir, 'character_npc.png'));
    }
    report.errors = cdp.errors;
    const reportPath = resolve(outDir, 'capture-report.json');
    if (requestedViews.length && existsSync(reportPath)) {
      const previous = JSON.parse(readFileSync(reportPath, 'utf8'));
      const merged = new Map((previous.views ?? []).map((view) => [view.name, view]));
      for (const view of report.views) merged.set(view.name, view);
      report.views = [...merged.values()];
    }
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    if (report.errors.length) throw new Error(`browser console/runtime errors: ${report.errors.join('\n')}`);
    console.log(`[village-fidelity] wrote ${report.views.length} captures and report to ${outDir}`);
  } finally {
    cdp?.ws.close();
    chrome.kill('SIGTERM');
  }
}

main().catch((error) => { console.error(`[village-fidelity] ${error instanceof Error ? error.stack : String(error)}`); process.exitCode = 1; });
