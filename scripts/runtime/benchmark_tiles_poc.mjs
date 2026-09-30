// Compares one native gameplay terrain tile to equivalent 3D Tiles content in
// the same isolated Babylon scene, camera, lighting, atlas and browser setup.
//
// Usage: node scripts/runtime/benchmark_tiles_poc.mjs [--base URL] [--chrome PATH]
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const argv = process.argv.slice(2);
function arg(name, fallback) {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
}
const EXTERNAL_BASE = arg('--base', null);
const CHROME = arg('--chrome', 'google-chrome');
const OUT_FILE = resolve(root, 'outputs/runtime-v2/tiles-benchmark.json');
const VIEW = {
  x: 3900, y: 600, z: 3100, tx: 3500, ty: 120, tz: 3500,
};
const TILE_VIEW = {
  x: VIEW.x, y: -VIEW.z, z: VIEW.y,
  tx: VIEW.tx, ty: -VIEW.tz, tz: VIEW.ty,
};
const WIDTH = 1280;
const HEIGHT = 720;
const WARMUP_MS = 1800;
const FRAME_SAMPLE_MS = 5000;
const READY_TIMEOUT_MS = 12000;
let managedServer = null;
process.on('exit', () => {
  if (!managedServer) return;
  managedServer.server.kill('SIGKILL');
  rmSync(managedServer.directory, { recursive: true, force: true });
});

const wait = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms));
async function getJson(url, init) {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(`${url} -> HTTP ${response.status}`);
  return response.json();
}
async function freePort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => server.listen(0, '127.0.0.1', resolveListen).once('error', reject));
  const port = server.address().port;
  await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  return port;
}

async function startLocalVite() {
  const directory = mkdtempSync(join(tmpdir(), 'montes-tiles-vite-'));
  // Keep Vite's optimized shader modules under its allowed workspace root.
  // A cache in /tmp is later imported through /@fs and rejected by strict fs access.
  const cacheDir = join(root, 'node_modules', '.cache', `montes-tiles-vite-${process.pid}-${Date.now()}`);
  mkdirSync(cacheDir, { recursive: true });
  const configPath = join(directory, 'vite.config.mjs');
  const port = await freePort();
  const viteEntry = resolve(root, 'node_modules/vite/dist/node/index.js');
  writeFileSync(configPath,
    `import { defineConfig } from ${JSON.stringify(`file://${viteEntry}`)};\n` +
    `export default defineConfig({ cacheDir: ${JSON.stringify(cacheDir)} });\n`);
  const server = spawn(resolve(root, 'node_modules/.bin/vite'), [
    root, '--config', configPath, '--host', '127.0.0.1', '--port', String(port), '--strictPort', '--force',
  ], { cwd: root, stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let attempt = 0; attempt < 90 && !ready; attempt++) {
    try {
      const html = await fetch(`${base}/tiles-poc.html`);
      // Transform the actual entry so readiness uses this server's isolated
      // optimizer cache, including on a checkout without a default .vite cache.
      const dependency = await fetch(`${base}/src/tiles-poc.ts`);
      ready = html.ok && dependency.ok;
    } catch { /* Wait for isolated dependency optimization. */ }
    if (!ready) await wait(500);
  }
  if (!ready) {
    server.kill('SIGKILL');
    rmSync(directory, { recursive: true, force: true });
    rmSync(cacheDir, { recursive: true, force: true });
    throw new Error('Isolated Vite server did not finish preparing the local 3D Tiles dependency');
  }
  return { base, server, directory, cacheDir };
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.requests = new Map();
    this.consoleErrors = [];
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.method === 'Network.requestWillBeSent') {
        const request = message.params.request;
        if (/^https?:/.test(request.url)) this.requests.set(message.params.requestId, {
          url: request.url,
          method: request.method,
          type: message.params.type,
          startedAt: message.params.timestamp,
          status: null,
          mimeType: null,
          encodedBytes: null,
          durationMs: null,
        });
      } else if (message.method === 'Network.responseReceived') {
        const request = this.requests.get(message.params.requestId);
        if (request) {
          request.status = message.params.response.status;
          request.mimeType = message.params.response.mimeType;
        }
      } else if (message.method === 'Network.loadingFinished') {
        const request = this.requests.get(message.params.requestId);
        if (request) {
          request.encodedBytes = message.params.encodedDataLength;
          request.durationMs = Math.max(0, (message.params.timestamp - request.startedAt) * 1000);
        }
      } else if (message.method === 'Network.loadingFailed') {
        const request = this.requests.get(message.params.requestId);
        if (request) request.failure = message.params.errorText;
      } else if (message.method === 'Runtime.exceptionThrown') {
        const details = message.params.exceptionDetails;
        this.consoleErrors.push(details?.exception?.description ?? details?.text ?? 'runtime exception');
      } else if (message.method === 'Log.entryAdded' && message.params.entry?.level === 'error') {
        this.consoleErrors.push(message.params.entry.text ?? 'console error');
      }
      if (message.id !== undefined && this.pending.has(message.id)) {
        const { resolve: done, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(JSON.stringify(message.error)));
        else done(message.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  async evaluate(expression) {
    const response = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text ?? 'Runtime.evaluate failed');
    return response.result.value;
  }
  resetPageData() {
    this.requests.clear();
    this.consoleErrors.length = 0;
  }
}

async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolveOpen, reject) => {
    ws.addEventListener('open', resolveOpen, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  return new Cdp(ws);
}

function frameSummary(frames) {
  const sorted = [...frames].filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return { samples: 0, meanMs: null, p50Ms: null, p95Ms: null, maxMs: null, fpsFromMean: null };
  const percentile = (p) => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
  const meanMs = sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
  return {
    samples: sorted.length,
    meanMs: Number(meanMs.toFixed(3)),
    p50Ms: Number(percentile(0.5).toFixed(3)),
    p95Ms: Number(percentile(0.95).toFixed(3)),
    maxMs: Number(sorted.at(-1).toFixed(3)),
    fpsFromMean: Number((1000 / meanMs).toFixed(1)),
  };
}

function countSummary(values) {
  const sorted = [...values].filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return { samples: 0, mean: null, p50: null, p95: null, max: null };
  const percentile = (p) => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
  return {
    samples: sorted.length,
    mean: Number((sorted.reduce((sum, value) => sum + value, 0) / sorted.length).toFixed(2)),
    p50: percentile(0.5),
    p95: percentile(0.95),
    max: sorted.at(-1),
  };
}

async function samplePage(cdp, kind, startedAt) {
  const readyExpression = kind === 'terrain'
    ? '!!window.__tilesBenchmark?.terrain?.meshes?.some((mesh) => mesh.getTotalVertices() > 0)'
    : '!!window.__tilesBenchmark?.tiles?.activeTiles?.size';
  const loadedExpression = `({ ready: ${readyExpression}, title: document.title, status: document.getElementById('status')?.textContent ?? '', activeTiles: window.__tilesBenchmark?.tiles?.activeTiles?.size ?? 0 })`;
  let ready = false;
  let firstModelAtMs = null;
  while (Date.now() - startedAt < READY_TIMEOUT_MS) {
    const info = await cdp.evaluate(loadedExpression).catch(() => null);
    if (kind === 'tiles' && info?.status?.startsWith('3D Tiles load error')) {
      throw new Error(`${info.status}; browser errors: ${cdp.consoleErrors.join(' | ')}`);
    }
    if (info?.ready) {
      ready = true;
      firstModelAtMs = Date.now() - startedAt;
      break;
    }
    await wait(100);
  }
  const rootReady = await cdp.evaluate(readyExpression).catch(() => false);

  await cdp.evaluate('window.__tilesBenchmark.renderTimes.length = 0; window.__tilesBenchmark.drawCallsPerFrame.length = 0');

  await wait(WARMUP_MS);
  await cdp.evaluate(`(() => {
    window.__benchmarkFrames = [];
    let previous = null;
    const start = performance.now();
    const tick = (now) => {
      if (previous !== null && now - start <= ${FRAME_SAMPLE_MS}) window.__benchmarkFrames.push(now - previous);
      previous = now;
      if (now - start < ${FRAME_SAMPLE_MS}) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  })()`);
  await wait(FRAME_SAMPLE_MS + 150);

  const detail = await cdp.evaluate(`(() => {
    const runtime = window.__tilesBenchmark;
    const scene = runtime?.scene ?? null;
    const engine = runtime?.engine ?? null;
    const camera = runtime?.camera ?? null;
    const terrainRuntime = runtime?.terrain?.residencyStats?.() ?? null;
    const drawCallsPerFrame = runtime?.drawCallsPerFrame ?? [];
    const meshes = scene?.meshes?.filter((mesh) => mesh.isEnabled()) ?? [];
    camera?.getViewMatrix(true);
    camera?.getProjectionMatrix(true);
    const meshMetrics = meshes.map((mesh) => ({
      name: mesh.name,
      vertices: mesh.getTotalVertices(),
      indices: mesh.getTotalIndices(),
      visible: mesh.isVisible,
      visibility: mesh.visibility,
      enabled: mesh.isEnabled(),
      subMeshes: mesh.subMeshes?.length ?? null,
      material: mesh.material ? {
        name: mesh.material.name,
        type: mesh.material.getClassName(),
        ready: mesh.material.isReady(mesh),
        textures: mesh.material.getActiveTextures().map((texture) => ({
          name: texture.name,
          ready: texture.isReady(),
          width: texture.getSize().width,
          height: texture.getSize().height,
        })),
      } : null,
      inFrustum: mesh.isInFrustum(runtime?.frustumPlanes?.() ?? []),
      worldBounds: mesh.getBoundingInfo().boundingBox ? {
        min: mesh.getBoundingInfo().boundingBox.minimumWorld.asArray(),
        max: mesh.getBoundingInfo().boundingBox.maximumWorld.asArray(),
      } : null,
    }));
    const terrainMeshes = meshMetrics.filter((mesh) => mesh.vertices > 0);
    const renderer = (() => {
      const engine = scene?.getEngine?.();
      const gl = engine?._gl;
      if (!gl) return null;
      const extension = gl.getExtension('WEBGL_debug_renderer_info');
      return extension ? gl.getParameter(extension.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    })();
    const memory = performance.memory ? {
      usedJSHeapSize: performance.memory.usedJSHeapSize,
      totalJSHeapSize: performance.memory.totalJSHeapSize,
      jsHeapSizeLimit: performance.memory.jsHeapSizeLimit,
    } : null;
    let gpuFrameTimeMs = null;
    let gpuTiming = { timerQueryAvailable: false, measured: false, reason: 'GPU timer query unavailable' };
    if (engine) {
      const timerQueryAvailable = Boolean(engine.getCaps().timerQuery);
      if (timerQueryAvailable) {
        try {
          const gpuTimeNs = engine.getGPUFrameTimeCounter().lastSecAverage;
          gpuFrameTimeMs = gpuTimeNs > 0 ? gpuTimeNs / 1e6 : null;
          gpuTiming = { timerQueryAvailable, measured: gpuFrameTimeMs !== null, sourceUnit: 'nanoseconds', reason: 'WebGL TIME_ELAPSED query converted from ns to ms; SwiftShader is a software-renderer measurement' };
        } catch (error) { gpuTiming = { timerQueryAvailable, measured: false, reason: String(error) }; }
      }
    }
    return {
      rendererMode: runtime?.renderer ?? null,
      terrainRuntime,
      cpuSceneRenderTimes: runtime?.renderTimes ?? [],
      drawCallsPerFrame,
      gpuTiming: { ...gpuTiming, frameTimeMs: gpuFrameTimeMs },
      scene: scene ? {
        activeMeshes: scene.getActiveMeshes().length,
        activeIndices: scene.getActiveIndices(),
        totalVertices: scene.getTotalVertices(),
        drawCalls: drawCallsPerFrame.length ? drawCallsPerFrame.at(-1) : null,
        renderer,
      } : null,
      camera: camera ? {
        position: camera.globalPosition.asArray(),
        target: camera.getTarget?.()?.asArray?.() ?? null,
        up: camera.upVector.asArray(),
        view: camera.getViewMatrix(true).asArray(),
        projection: camera.getProjectionMatrix(true).asArray(),
        frustumPlanes: runtime?.frustumPlanes?.().map((plane) => ({ normal: plane.normal.asArray(), d: plane.d })) ?? null,
      } : null,
      meshMetrics,
      terrainMeshes,
      tilesRenderer: runtime?.tiles ? {
        activeTiles: runtime.tiles.activeTiles?.size ?? null,
        visibleTiles: runtime.tiles.visibleTiles?.size ?? null,
        loadProgress: runtime.tiles.loadProgress ?? null,
        root: runtime.tiles.root ? {
          boundingVolume: runtime.tiles.root.boundingVolume,
          transform: runtime.tiles.root.transform,
          traversal: runtime.tiles.root.traversal,
          hasContent: runtime.tiles.root.internal?.hasContent,
          hasRenderableContent: runtime.tiles.root.internal?.hasRenderableContent,
          loadingState: runtime.tiles.root.internal?.loadingState,
          content: runtime.tiles.root.content,
        } : null,
      } : null,
      memory,
      frames: window.__benchmarkFrames ?? [],
      hud: document.getElementById('hud')?.textContent ?? null,
      status: document.getElementById('status')?.textContent ?? null,
    };
  })()`);
  const frames = detail.frames;
  const cpuFrames = detail.cpuSceneRenderTimes;
  const requests = [...cdp.requests.values()];
  const classified = requests.filter((request) => {
    const path = new URL(request.url).pathname;
    return path === '/terrain/config.json' || path === '/terrain/orthophoto.json' ||
      path === '/terrain/tiles/tile_3_3.json' || path === '/terrain/orthophoto.webp' ||
      path.startsWith('/tiles-benchmark/equivalent/');
  });
  const vertices = detail.terrainMeshes.reduce((sum, mesh) => sum + mesh.vertices, 0);
  const indices = detail.terrainMeshes.reduce((sum, mesh) => sum + mesh.indices, 0);
  const scopeMetrics = {
    renderer: kind,
    totalScene: {
      drawCalls: detail.scene?.drawCalls ?? null,
      triangles: detail.scene ? detail.scene.activeIndices / 3 : null,
      activeMeshes: detail.scene?.activeMeshes ?? null,
    },
    terrain: {
      visibleTriangles: detail.scene ? detail.scene.activeIndices / 3 : null,
      meshCount: detail.terrainMeshes.length,
      vertices,
      indices,
      geometryBufferBytesEstimate: vertices * (3 + 3 + 4 + 2) * 4 + indices * 2,
      residentGpuMeshes: detail.terrainRuntime?.residentGpuMeshes ?? detail.tilesRenderer?.activeTiles ?? null,
      retainedCpuHeightBytesEstimate: detail.terrainRuntime?.retainedCpuHeightBytesEstimate ?? null,
      visibleTiles: detail.tilesRenderer?.visibleTiles ?? null,
    },
  };
  return {
    ready,
    rootReady,
    readinessIssue: ready && rootReady ? null : `${kind} did not become ready within ${READY_TIMEOUT_MS}ms`,
    firstModelAtMs,
    metrics: {
      ...detail,
      frames: frameSummary(frames),
      cpuSceneRender: frameSummary(cpuFrames),
      drawCallsPerFrame: countSummary(detail.drawCallsPerFrame),
      scope: scopeMetrics,
    },
    network: {
      allRequests: requests.length,
      benchmarkAssetRequests: classified.length,
      benchmarkAssetEncodedBytes: classified.reduce((sum, request) => sum + (request.encodedBytes ?? 0), 0),
      failedRequests: classified.filter((request) => request.failure || (request.status !== null && request.status >= 400)).length,
      assets: classified.map(({ url, type, status, mimeType, encodedBytes, durationMs, failure }) => ({
        path: new URL(url).pathname, type, status, mimeType, encodedBytes, durationMs, ...(failure ? { failure } : {}),
      })),
      consoleErrors: [...cdp.consoleErrors],
    },
  };
}

async function main() {
  const terrainConfig = JSON.parse(readFileSync(resolve(root, 'public/terrain/config.json'), 'utf8'));
  const orthoManifest = JSON.parse(readFileSync(resolve(root, 'public/terrain/orthophoto.json'), 'utf8'));
  const terrainTile = JSON.parse(readFileSync(resolve(root, 'public/terrain/tiles/tile_3_3.json'), 'utf8'));
  const tileset = JSON.parse(readFileSync(resolve(root, 'public/tiles-benchmark/equivalent/tileset.json'), 'utf8'));
  const gltf = JSON.parse(readFileSync(resolve(root, 'public/tiles-benchmark/equivalent/tile.gltf'), 'utf8'));
  const gltfBinaryBytes = statSync(resolve(root, 'public/tiles-benchmark/equivalent/tile.bin')).size;
  const localServer = EXTERNAL_BASE ? null : await startLocalVite();
  managedServer = localServer;
  const base = EXTERNAL_BASE ?? localServer.base;
  const pages = {};
  const browserVersions = {};
  const screenshotDir = resolve(root, 'outputs/runtime-v2/tiles-benchmark');
  mkdirSync(screenshotDir, { recursive: true });
  try {
    for (const kind of ['terrain', 'tiles']) {
      const port = await freePort();
      const profile = mkdtempSync(join(tmpdir(), `montes-equivalent-${kind}-`));
      const chrome = spawn(CHROME, [
        '--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars',
        `--window-size=${WIDTH},${HEIGHT}`, '--enable-unsafe-swiftshader', '--use-angle=swiftshader',
        '--enable-precise-memory-info', `--remote-debugging-port=${port}`, '--remote-allow-origins=*',
        `--user-data-dir=${profile}`, 'about:blank',
      ], { stdio: 'ignore' });
      let cdp;
      try {
        let version = null;
        for (let attempt = 0; attempt < 60 && !version; attempt++) {
          try { version = await getJson(`http://127.0.0.1:${port}/json/version`); }
          catch { await wait(500); }
        }
        if (!version) throw new Error(`Chrome did not open CDP for ${kind}`);
        browserVersions[kind] = { userAgent: version.Browser, protocolVersion: version['Protocol-Version'] };
        const tab = await getJson(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' });
        cdp = await connect(tab.webSocketDebuggerUrl);
        await cdp.send('Page.enable');
        await cdp.send('Runtime.enable');
        await cdp.send('Log.enable');
        await cdp.send('Network.enable');
        await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
        await cdp.send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false });
        const query = new URLSearchParams({ benchmark: '1', renderer: kind, tile: 'tile_3_3', ...Object.fromEntries(Object.entries(TILE_VIEW).map(([key, value]) => [key, String(value)])) });
        const url = `${base}/tiles-poc.html?${query}`;
        console.log(`[tiles-benchmark] ${kind} -> ${url}`);
        const startedAt = Date.now();
        await cdp.send('Page.navigate', { url });
        const pageResult = await samplePage(cdp, kind, startedAt);
        const capture = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
        writeFileSync(resolve(screenshotDir, `${kind}.png`), Buffer.from(capture.data, 'base64'));
        pages[kind] = { url, browser: browserVersions[kind], ...pageResult };
      } finally {
        cdp?.ws.close();
        chrome.kill('SIGKILL');
        rmSync(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
      }
    }
  } finally {
    if (localServer) {
      localServer.server.kill('SIGKILL');
      rmSync(localServer.directory, { recursive: true, force: true });
      rmSync(localServer.cacheDir, { recursive: true, force: true });
      managedServer = null;
    }
  }

  const tileGrid = terrainTile.grid;
  const positionAccessor = gltf.accessors[gltf.meshes[0].primitives[0].attributes.POSITION];
  const indexAccessor = gltf.accessors[gltf.meshes[0].primitives[0].indices];
  const results = Object.fromEntries(Object.entries(pages).map(([key, page]) => [key, {
    readyMs: page.firstModelAtMs,
    frameMs: page.metrics.frames,
    cpuSceneRenderMs: page.metrics.cpuSceneRender,
    drawCalls: page.metrics.scope.totalScene.drawCalls,
    triangles: page.metrics.scope.totalScene.triangles,
    heapBytes: page.metrics.memory?.usedJSHeapSize ?? null,
    requests: page.network.benchmarkAssetRequests,
    encodedBytes: page.network.benchmarkAssetEncodedBytes,
    failedRequests: page.network.failedRequests,
    renderer: page.metrics.scene?.renderer,
  }]));
  const result = {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    benchmark: {
      status: Object.values(results).every((entry) => entry.triangles === indexAccessor.count / 3)
        ? 'equivalent-single-tile-observation'
        : 'invalid-visible-geometry-count',
      rendererComparisonValid: Object.values(results).every((entry) => entry.triangles === indexAccessor.count / 3),
      validityIssues: Object.entries(results)
        .filter(([, entry]) => entry.triangles !== indexAccessor.count / 3)
        .map(([renderer, entry]) => `${renderer}: captured ${entry.triangles} visible triangles, expected ${indexAccessor.count / 3}`),
      scope: 'One 1 km current terrain tile vs one root 3D Tile in the same minimal Babylon app.',
      comparableInputs: {
        tileId: terrainTile.id,
        dimensions: { widthM: (tileGrid.columns - 1) * tileGrid.dx, depthM: (tileGrid.rows - 1) * tileGrid.dz, columns: tileGrid.columns, rows: tileGrid.rows, sampleM: tileGrid.dx },
        worldScale: terrainConfig.worldScale,
        verticalDatumM: terrainConfig.verticalDatum,
        orthophoto: { url: orthoManifest.asset.url, width: orthoManifest.asset.width, height: orthoManifest.asset.height, encodedBytes: orthoManifest.asset.bytes, sha256: orthoManifest.asset.sha256, decodedRgbaPlusMipsBytes: orthoManifest.budgets.decodedRgbaPlusMipsBytes },
        terrainMesh: { vertices: positionAccessor.count, indices: indexAccessor.count, triangles: indexAccessor.count / 3, gltfBinaryBytes: gltfBinaryBytes, geometryBufferBytesEstimate: positionAccessor.count * (3 + 3 + 4 + 2) * 4 + indexAccessor.count * 2 },
        material: { colorSpace: 'sRGB orthophoto atlas', metallic: 0, roughness: 0.96, atlasFiltering: 'linear mag + trilinear min' },
        scene: { rightHanded: true, coordinates: 'Babylon 3D Tiles Z-up frame; terrain and camera rotated from gameplay Y-up by +90deg around X', width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, gameplayCamera: VIEW, rendererCamera: TILE_VIEW, warmupMs: WARMUP_MS, sampleMs: FRAME_SAMPLE_MS },
      },
      exclusions: [
        'This measures only a single root tile at one fixed view. It does not exercise hierarchical LOD, multiple-tile selection, refinement, unload hysteresis, or streaming continuity.',
        'Both paths use the same source DEM grid and atlas. The current terrain path parses JSON height samples and generates its mesh at load; 3D Tiles downloads a prepacked glTF binary.',
        'JS heap is whole-page heap and includes renderer/bootstrap allocations; it is not isolated texture VRAM or total GPU memory.',
      ],
      timing: {
        browserFrameIntervals: 'requestAnimationFrame interval; includes browser scheduling and software renderer pacing.',
        cpuSceneRender: 'performance.now around Babylon before/after render observables; main-thread render pass, not isolated CPU-only work.',
        gpu: 'WebGL timer query recorded only when the runtime reports a usable timer query; SwiftShader timings are software-renderer results, not RTX GPU measurements.',
      },
      performanceClaims: 'No renderer performance win is inferred from these observations.',
      server: { mode: localServer ? 'isolated Vite dev server with temporary dependency cache' : 'external Vite dev server', base },
      browser: { instances: browserVersions, cacheDisabled: true, separateFreshProcessPerRenderer: true, backend: 'SwiftShader forced by Chrome launch flags' },
      references: {
        nasaAmmos: { url: 'https://github.com/NASA-AMMOS/3DTilesRendererJS', license: 'Apache-2.0', babylonApi: 'TilesRenderer(url, scene); scene.onBeforeRenderObservable -> tiles.update(); scene.render()', documentedLimit: 'Babylon renderer requires right-handed scene coordinates; this single-root dataset cannot benchmark hierarchy or LOD.' },
        babylonDemo: { url: 'https://github.com/gkjohnson/babylon-3dtiles-demo', license: 'Apache-2.0', use: 'Minimal Babylon integration example only.' },
      },
    },
    pages,
    summary: results,
    screenshots: { terrain: 'outputs/runtime-v2/tiles-benchmark/terrain.png', tiles: 'outputs/runtime-v2/tiles-benchmark/tiles.png' },
  };
  mkdirSync(dirname(OUT_FILE), { recursive: true });
  writeFileSync(OUT_FILE, JSON.stringify(result, null, 2) + '\n');
  console.log(`\n=> ${OUT_FILE}`);
  console.log(JSON.stringify({ status: result.benchmark.status, summary: result.summary }, null, 2));
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
