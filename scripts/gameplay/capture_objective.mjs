// Captura del objetivo (repetidor) en Chrome headless + CDP, SIN Playwright y
// con cero dependencias nuevas. Copia el patrón de `scripts/vehicle/capture_vehicle.mjs`
// y `scripts/roads/draping/capture_draping.mjs`.
//
// Por qué usa la página `objective_preview.html` y no la app: `src/main.ts` aún no
// instancia el objetivo (la integración de `window.__game` la hace el orquestador).
// La preview arma el terreno REAL + el objetivo para poder verlo igual.
//
// Uso: node scripts/gameplay/capture_objective.mjs [--out-dir output/milestone1] [--port 9226] [--base http://127.0.0.1:4173]
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');

const argv = process.argv.slice(2);
function arg(name, fallback) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
}
const PORT = Number(arg('--port', '9226'));
const BASE = arg('--base', 'http://127.0.0.1:4173');
const OUT_DIR = resolve(root, arg('--out-dir', 'output/milestone1'));
const CHROME = arg('--chrome', 'google-chrome');
const PROFILE = '/tmp/opencode/chrome-cdp-profile-objective';

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchJson(url, init) {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve: res, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else res(msg.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, reject) => this.pending.set(id, { resolve: res, reject }));
  }
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'evaluate error');
    }
    return result.result.value;
  }
  async screenshot(file) {
    const shot = await this.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(file, Buffer.from(shot.data, 'base64'));
  }
}

async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, reject) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  return new Cdp(ws);
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  rmSync(PROFILE, { recursive: true, force: true });

  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--hide-scrollbars',
      '--window-size=1280,720',
      '--enable-unsafe-swiftshader',
      '--use-angle=swiftshader',
      `--remote-debugging-port=${PORT}`,
      '--remote-allow-origins=*',
      `--user-data-dir=${PROFILE}`,
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  try {
    let version = null;
    for (let i = 0; i < 60 && !version; i++) {
      try {
        version = await fetchJson(`http://127.0.0.1:${PORT}/json/version`);
      } catch {
        await wait(500);
      }
    }
    if (!version) throw new Error('Chrome no abrió el puerto de depuración');

    const tab = await fetchJson(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' });
    const cdp = await connect(tab.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });

    console.log(`[objetivo] navegando a ${BASE}/objective_preview.html`);
    await cdp.send('Page.navigate', { url: `${BASE}/objective_preview.html` });

    let ready = false;
    for (let i = 0; i < 120 && !ready; i++) {
      await wait(1000);
      try {
        ready = await cdp.evaluate('!!(window.__preview && window.__preview.ready)');
      } catch {
        ready = false;
      }
    }
    if (!ready) throw new Error('window.__preview no estuvo listo (¿error al cargar?)');
    await wait(2500);

    const report = { generado_por: 'scripts/gameplay/capture_objective.mjs', base: BASE, fecha: new Date().toISOString() };

    // Chequeo "la base apoya": min(huella) == Y del root y ninguna muestra por
    // debajo del root (si alguna lo estuviera, la losa flotaría).
    report.apoyo = await cdp.evaluate('window.__preview.footprint()');
    report.target = await cdp.evaluate('window.__preview.target');
    console.log(
      `[objetivo] apoyo: rootY=${report.apoyo.rootY.toFixed(3)} min=${report.apoyo.min.toFixed(3)} ` +
        `max=${report.apoyo.max.toFixed(3)} floating=${report.apoyo.floating}`,
    );

    // --- Captura 1: aproximación desde la pista, baliza apagada/roja ---
    await cdp.evaluate('window.__preview.setRepair(0)');
    await wait(800);
    await cdp.screenshot(resolve(OUT_DIR, '12_objective_approach.png'));
    console.log('[objetivo] captura aproximación (baliza apagada) -> output/milestone1/12_objective_approach.png');

    // --- Captura 2: reparado, baliza verde ---
    await cdp.evaluate('window.__preview.setRepair(1)');
    await wait(800);
    await cdp.screenshot(resolve(OUT_DIR, '13_objective_repaired.png'));
    console.log('[objetivo] captura reparado (baliza verde) -> output/milestone1/13_objective_repaired.png');

    writeFileSync(resolve(OUT_DIR, 'objective_captures.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(`\n=> capturas en ${OUT_DIR}`);
  } finally {
    chrome.kill('SIGKILL');
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
