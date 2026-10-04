// Frozen-source native-CDP comparison for the compressed-edge junction at
// way 548355745. Only road-draping.ts differs between the two Vite roots.
// Usage: node scripts/roads/capture_junction_pair.mjs
// Third-view refresh from the preserved isolated roots: add --third-only.
import { spawn, execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const outDir = resolve(root, 'outputs/village-fidelity-20261004/road-visual-pair');
const portBefore = Number(process.env.JUNCTION_BEFORE_PORT ?? 4197);
const portAfter = Number(process.env.JUNCTION_AFTER_PORT ?? 4198);
const cdpPort = Number(process.env.JUNCTION_CDP_PORT ?? 9347);
const chromePath = process.env.CHROME ?? 'google-chrome';
const profile = `/tmp/montes-road-junction-pair-${process.pid}`;
const pairSource = resolve(outDir, 'frozen-src');
const snapshot = resolve(root, 'outputs/village-fidelity-20261004/road-fix/snapshot/road-draping.ts');
const candidate = resolve(root, 'src/road-draping.ts');
const runId = new Date().toISOString();
const thirdOnly = process.argv.includes('--third-only');

function sha256(file) { return createHash('sha256').update(readFileSync(file)).digest('hex'); }
function treeHash(dir) {
  const files = [];
  function walk(current, rel = '') {
    for (const name of readdirSync(current).sort()) {
      const full = resolve(current, name); const path = rel ? `${rel}/${name}` : name;
      const stat = statSync(full);
      if (stat.isDirectory()) walk(full, path);
      else if (stat.isFile()) files.push({ path, sha256: sha256(full) });
    }
  }
  walk(dir);
  return { files, sha256: createHash('sha256').update(JSON.stringify(files)).digest('hex') };
}
function wait(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
async function getJson(url, init) {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.json();
}

class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.console = [];
    ws.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(message.params.type)) {
        this.console ??= [];
        this.console.push({ type: message.params.type, args: message.params.args.map(arg => arg.value ?? arg.description ?? arg.type) });
      }
      if (message.id === undefined || !this.pending.has(message.id)) return;
      const pending = this.pending.get(message.id); this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
      else pending.resolve(message.result);
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  }
  async screenshot(file) {
    const result = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    writeFileSync(file, Buffer.from(result.data, 'base64'));
  }
}

async function waitForApp(cdp) {
  for (let i = 0; i < 180; i++) {
    try {
      if (await cdp.evaluate('!!(window.__game?.roads && window.__game?.terrainHeightAt)')) return;
    } catch { /* navigation is still loading */ }
    await wait(500);
  }
  let page = null;
  try { page = await cdp.evaluate('({url:location.href,readyState:document.readyState,hud:document.querySelector("#hud")?.textContent,game:!!window.__game,roads:!!window.__game?.roads,body:document.body.innerText.slice(0,600)})'); } catch { /* navigation may have no execution context */ }
  throw new Error(`The game road/terrain API did not become ready. Page=${JSON.stringify(page)} Browser console=${JSON.stringify(cdp.console.slice(-12))}`);
}

function startServer(dir, port) {
  const server = spawn(process.execPath, [resolve(dir, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
    cwd: dir, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  server.stdout.on('data', chunk => { logs += chunk.toString(); });
  server.stderr.on('data', chunk => { logs += chunk.toString(); });
  return { dir, server, get logs() { return logs; } };
}

function isolatedRoot(phase, port) {
  const dir = resolve(outDir, phase);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  cpSync(pairSource, resolve(dir, 'src'), { recursive: true });
  for (const name of ['index.html', 'package.json', 'vite.config.ts', 'tsconfig.json']) cpSync(resolve(root, name), resolve(dir, name));
  symlinkSync(relative(dir, resolve(root, 'public')), resolve(dir, 'public'), 'dir');
  symlinkSync(relative(dir, resolve(root, 'node_modules')), resolve(dir, 'node_modules'), 'dir');
  return startServer(dir, port);
}

async function waitForServer(port, serverInfo) {
  for (let i = 0; i < 80; i++) {
    if (serverInfo.server.exitCode !== null) throw new Error(`Vite exited: ${serverInfo.logs}`);
    try { await fetch(`http://127.0.0.1:${port}/`); return; } catch { await wait(250); }
  }
  throw new Error(`Vite did not start on ${port}: ${serverInfo.logs}`);
}

async function main() {
  mkdirSync(outDir, { recursive: true });
  if (!existsSync(snapshot) || !existsSync(candidate)) throw new Error('Missing baseline snapshot or current road-draping.ts.');
  const publicBefore = treeHash(resolve(root, 'public'));

  let before, after, report;
  if (thirdOnly) {
    report = JSON.parse(readFileSync(resolve(outDir, 'capture-report.json'), 'utf8'));
    if (!existsSync(pairSource) || sha256(candidate) !== report.source.afterRoadDrapingSha256 || publicBefore.sha256 !== report.source.publicSha256) {
      throw new Error('Frozen sources or public inputs no longer match the original paired capture.');
    }
    before = startServer(resolve(outDir, 'before'), portBefore);
    after = startServer(resolve(outDir, 'after'), portAfter);
    rmSync(resolve(outDir, 'before_skirt_edge_topdown.png'), { force: true });
    rmSync(resolve(outDir, 'after_skirt_edge_topdown.png'), { force: true });
    report.thirdViewStartedAt = runId;
  } else {
    // Freeze all app source before making either isolated copy. Preserve every
    // currently dirty shared source file exactly as observed for both phases.
    rmSync(pairSource, { recursive: true, force: true });
    cpSync(resolve(root, 'src'), pairSource, { recursive: true });
    const frozenDraping = readFileSync(resolve(pairSource, 'road-draping.ts'));
    const copiedSnapshot = readFileSync(snapshot);
    const copiedCandidate = Buffer.from(frozenDraping);

    before = isolatedRoot('before', portBefore);
    after = isolatedRoot('after', portAfter);
    writeFileSync(resolve(before.dir, 'src/road-draping.ts'), copiedSnapshot);
    writeFileSync(resolve(after.dir, 'src/road-draping.ts'), copiedCandidate);
  }

  let chrome;
  try {
    await Promise.all([waitForServer(portBefore, before), waitForServer(portAfter, after)]);
    chrome = spawn(chromePath, [
      '--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars',
      '--window-size=1280,720', '--force-device-scale-factor=1', '--enable-unsafe-swiftshader',
      '--use-angle=swiftshader', `--remote-debugging-port=${cdpPort}`, '--remote-allow-origins=*',
      `--user-data-dir=${profile}`, 'about:blank',
    ], { stdio: 'ignore' });

    let version = null;
    for (let i = 0; i < 80 && !version; i++) {
      try { version = await getJson(`http://127.0.0.1:${cdpPort}/json/version`); } catch { await wait(250); }
    }
    if (!version) throw new Error('Chrome failed to open its private CDP port.');
    const tab = await getJson(`http://127.0.0.1:${cdpPort}/json/new?about:blank`, { method: 'PUT' });
    const ws = new WebSocket(tab.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
    const cdp = new Cdp(ws);
    await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });

    const target = { x: 2961.1101888020835, z: 3510.3418782552085 };
    const views = [
      { id: 'junction_oblique', label: 'oblique close', dx: -13, dz: -13, rise: 10 },
      { id: 'junction_high', label: 'high oblique', dx: 1, dz: -3, rise: 27 },
      { id: 'skirt_edge_roadside', label: 'close bend-aligned view from open southwest approach', target: { x: 2960.6402180989585, z: 3509.562744140625 }, dx: -5.7, dz: 2.9, rise: 8, terrainY: 90.93162434895828 },
    ];
    report ??= {
      generatedAt: runId,
      source: {
        checkoutHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), branch: execFileSync('git', ['branch', '--show-current'], { cwd: root, encoding: 'utf8' }).trim(),
        beforeRoadDrapingSha256: sha256(snapshot),
        afterRoadDrapingSha256: createHash('sha256').update(copiedCandidate).digest('hex'),
        publicSha256: publicBefore.sha256,
        note: 'Each phase uses a full isolated src copy and the same linked public assets, dependency tree, app root files, and camera parameters. Current dirty shared sources were frozen before either server started.',
      },
      browser: { chrome: version.Browser, viewport: '1280x720', renderer: 'headless SwiftShader; visual comparison only' },
      target, sourceTriangleEvidence: {
        pavement: { index: 61626, center: [2961.1101888020835, 3510.3418782552085], gradeBefore: 5.19944551004454, gradeAfter: 0.7035306710963544 },
        skirt: { index: 61618, center: [2960.6402180989585, 3509.562744140625], gradeBefore: 23.72929035770484, gradeAfter: 32.42351500521316 },
      },
      captures: [],
    };
    // Correctly fingerprint the complete frozen shared TS input set.
    const sharedFiles = [];
    function walk(dir, rel = '') {
      for (const entry of readdirSync(dir)) {
        const full = resolve(dir, entry); const childRel = rel ? `${rel}/${entry}` : entry;
        const stat = statSync(full);
        if (stat.isDirectory()) walk(full, childRel);
        else if (entry.endsWith('.ts')) sharedFiles.push({ path: childRel, sha256: sha256(full) });
      }
    }
    walk(pairSource);
    report.source.sharedTypeScript = sharedFiles;
    report.source.sharedTypeScriptSha256 = createHash('sha256').update(JSON.stringify(sharedFiles)).digest('hex');
    delete report.source.frozenSharedSrcSha256;

    const activeViews = thirdOnly ? views.slice(-1) : views.slice(0, 2);
    for (const phase of ['before', 'after']) {
      const port = phase === 'before' ? portBefore : portAfter;
      for (const view of activeViews) {
        const focal = view.target ?? target;
        const terrainY = view.terrainY ?? 90.93162434895828;
        const precise = `http://127.0.0.1:${port}/?quality=HIGH&px=${focal.x + view.dx}&py=${terrainY + view.rise}&pz=${focal.z + view.dz}&tx=${focal.x}&ty=${terrainY}&tz=${focal.z}`;
        await cdp.send('Page.navigate', { url: precise });
        await waitForApp(cdp);
        await wait(12000);
        const consoleStart = cdp.console.length;
        const data = await cdp.evaluate(`(() => { const g=window.__game,p=${JSON.stringify(focal)}; return {url:location.href, targetTerrainY:g.terrainHeightAt(p.x,p.z), targetRoad:g.roads.sampleAt(p.x,p.z), perf:g.perf(), runtime:g.runtime()}; })()`);
        const imagePath = resolve(outDir, `${phase}_${view.id}.png`);
        await cdp.screenshot(imagePath);
        report.captures = report.captures.filter(capture => !(capture.phase === phase && capture.view === view.id) && !(thirdOnly && capture.view === 'skirt_edge_topdown'));
        report.captures.push({ phase, view: view.id, label: view.label, image: relative(root, imagePath), camera: { x: focal.x + view.dx, yOffsetAboveSharedTerrain: view.rise, z: focal.z + view.dz, targetX: focal.x, targetZ: focal.z }, observed: data, browserWarningsAndErrors: cdp.console.slice(consoleStart) });
        console.log(`${phase} ${view.id} ${imagePath}`);
      }
    }
    const publicAfter = treeHash(resolve(root, 'public'));
    report.source.publicStableDuringCapture = publicBefore.sha256 === publicAfter.sha256;
    report.source.publicSha256After = publicAfter.sha256;
    if (!report.source.publicStableDuringCapture) throw new Error('The linked public asset tree changed during capture; paired images cannot be treated as source-matched.');
    writeFileSync(resolve(outDir, 'capture-report.json'), `${JSON.stringify(report, null, 2)}\n`);
    console.log(resolve(outDir, 'capture-report.json'));
  } finally {
    chrome?.kill('SIGTERM');
    before.server.kill('SIGTERM'); after.server.kill('SIGTERM');
    await wait(500);
    rmSync(profile, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
