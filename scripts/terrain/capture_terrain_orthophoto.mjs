// Capturas CDP para validar la ortofoto sobre el terreno, sin tocar el presupuesto.
// Perfil temporal único por ejecución; el script elimina solo el perfil que crea.
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const argv = process.argv.slice(2);
function arg(name, fallback) {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback;
}

const PORT = Number(arg('--port', '9226'));
const BASE = arg('--base', 'http://127.0.0.1:5173');
const OUT_DIR = resolve(root, arg('--out-dir', 'output/terrain-orthophoto'));
const CHROME = arg('--chrome', 'google-chrome');
const PROFILE = mkdtempSync(join(tmpdir(), 'montes-oca-orthophoto-cdp-'));
const HEIGHT_REFERENCE = JSON.parse(readFileSync(resolve(root, 'docs/terrain/crosscheck.json'), 'utf8'));
const VIEWS = [
  ['terrain_pueblo', { px: 2750, py: 210, pz: 3350, tx: 3097, ty: 80, tz: 3950 }],
  ['terrain_montes', { px: 3097, py: 190, pz: 3450, tx: 1900, ty: 95, tz: 4300 }],
  ['terrain_drive', { px: 3140, py: 82, pz: 3970, tx: 3240, ty: 82, tz: 4050 }],
];

const wait = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms));

async function fetchJson(url, init) {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(`${url} -> HTTP ${response.status}`);
  return response.json();
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.consoleErrors = [];
    this.ignRequests = [];
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.method === 'Runtime.exceptionThrown') {
        this.consoleErrors.push(msg.params.exceptionDetails?.text ?? 'Runtime exception');
      } else if (msg.method === 'Log.entryAdded' && msg.params.entry?.level === 'error') {
        this.consoleErrors.push(msg.params.entry.text ?? 'Console error');
      } else if (msg.method === 'Network.requestWillBeSent') {
        const url = msg.params.request?.url ?? '';
        if (/ign\.es|cnig\.es/i.test(url)) this.ignRequests.push(url);
      }
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve: done, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else done(msg.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((done, reject) => this.pending.set(id, { resolve: done, reject }));
  }
  async evaluate(expression) {
    const response = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.text ?? 'evaluate error');
    return response.result.value;
  }
}

async function connect(url) {
  const ws = new WebSocket(url);
  await new Promise((done, reject) => {
    ws.addEventListener('open', done, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  return new Cdp(ws);
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const chrome = spawn(CHROME, [
    '--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars',
    '--window-size=1440,900', '--enable-unsafe-swiftshader', '--use-angle=swiftshader',
    `--remote-debugging-port=${PORT}`, '--remote-allow-origins=*', `--user-data-dir=${PROFILE}`, 'about:blank',
  ], { stdio: 'ignore' });

  let cdp;
  try {
    let version = null;
    for (let i = 0; i < 60 && !version; i++) {
      try { version = await fetchJson(`http://127.0.0.1:${PORT}/json/version`); }
      catch { await wait(500); }
    }
    if (!version) throw new Error('Chrome no abrió el puerto CDP');

    const tab = await fetchJson(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' });
    cdp = await connect(tab.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');
    await cdp.send('Network.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

    const captures = [];
    for (const [name, camera] of VIEWS) {
      const query = new URLSearchParams(Object.entries(camera).map(([key, value]) => [key, String(value)])).toString();
      const url = `${BASE}/?${query}`;
      console.log(`[capture] ${name} -> ${url}`);
      await cdp.send('Page.navigate', { url });

      let hud = '';
      for (let attempt = 0; attempt < 120; attempt++) {
        await wait(500);
        hud = await cdp.evaluate("document.getElementById('hud')?.textContent ?? ''");
        if (hud.includes('triángulos') || hud.includes('ERROR')) break;
      }
      await wait(1200);
      const diagnostics = await cdp.evaluate(`(() => {
        const game = window.__game;
        const reference = ${JSON.stringify(HEIGHT_REFERENCE.puntos)};
        if (!game) return null;
        const heightSamples = reference.map((point) => {
          const actual = game.terrainHeightAt(point.world_x, point.world_z);
          return { name: point.nombre, actual, expected: point.game_world_y, delta: actual - point.game_world_y };
        });
        return { perf: game.perf(), datumAudit: game.auditDatum(), heightSamples };
      })()`);
      const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      const imagePath = resolve(OUT_DIR, `${name}.png`);
      writeFileSync(imagePath, Buffer.from(screenshot.data, 'base64'));
      const entry = {
        name,
        url,
        image: imagePath,
        hud: hud.replace(/\s+/g, ' ').trim(),
        tiles: Number(/tiles\s+(\d+)/.exec(hud)?.[1] ?? NaN),
        triangles: Number(/triángulos\s+(\d+)/.exec(hud)?.[1] ?? NaN),
        trianglesInView: Number(/en vista\s+(\d+)/.exec(hud)?.[1] ?? NaN),
        diagnostics,
        consoleErrors: [...cdp.consoleErrors],
        requestsToIgnCnig: [...cdp.ignRequests],
      };
      captures.push(entry);
      console.log(`[capture] ${name}: tiles=${entry.tiles} triangles=${entry.triangles} visible=${entry.trianglesInView} consoleErrors=${entry.consoleErrors.length}`);
    }

    const report = {
      base: BASE,
      browser: version.Browser,
      renderer: 'Chrome headless + SwiftShader',
      texture: '/terrain/orthophoto.webp',
      captures,
      consoleErrors: [...new Set(captures.flatMap((capture) => capture.consoleErrors))],
      requestsToIgnCnig: [...new Set(captures.flatMap((capture) => capture.requestsToIgnCnig))],
      note: 'No performance claim for target GPUs; inspect aerial alignment, atlas seams, road overlay and driving-height texture detail in the PNGs.',
    };
    writeFileSync(resolve(OUT_DIR, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
    console.log(`\n=> ${captures.length} capturas + report.json en ${OUT_DIR}`);
    const heightDrift = captures.some((capture) =>
      !capture.diagnostics?.datumAudit?.ok ||
      capture.diagnostics.heightSamples.some((sample) => Math.abs(sample.delta) > 1e-3));
    if (heightDrift) {
      console.error('Las muestras de altura del navegador no coinciden con docs/terrain/crosscheck.json.');
      process.exitCode = 1;
    }
    if (report.consoleErrors.length) process.exitCode = 1;
    if (report.requestsToIgnCnig.length) {
      console.error('El runtime hizo peticiones inesperadas a IGN/CNIG.');
      process.exitCode = 1;
    }
  } finally {
    cdp?.ws.close();
    chrome.kill('SIGKILL');
    await wait(250);
    rmSync(PROFILE, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
