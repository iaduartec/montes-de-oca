// Captura de pantalla + medición real del terreno usando Chrome headless vía CDP
// (Chrome DevTools Protocol) con el WebSocket nativo de Node. No agrega deps.
//
// - Levanta Chrome con --remote-debugging-port.
// - Navega a cada vista (parámetros px/py/pz/tx/ty/tz de la app).
// - Espera a que el HUD deje de decir "Cargando terreno…".
// - Lee `triángulos` y `en vista` del HUD y guarda la captura PNG.
//
// Uso: node scripts/terrain/capture_terrain.mjs [--out-dir output] [--port 9223]
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');

const argv = process.argv.slice(2);
function arg(name, fallback) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
}
const PORT = Number(arg('--port', '9223'));
const BASE = arg('--base', 'http://127.0.0.1:4173');
const OUT_DIR = resolve(root, arg('--out-dir', 'output'));
const CHROME = arg('--chrome', 'google-chrome');
const PROFILE = '/tmp/opencode/chrome-cdp-profile';

// [nombre, { px, py, pz, tx, ty, tz }]  — coords de mundo (metros).
// OJO: Y = elevación − verticalDatum(870). El pueblo está a Y≈75.
const VIEWS = [
  // Vista por defecto de la app (sin parámetros): spawn desde config, mirando al norte.
  ['terrain_default', null],
  // Vista general del pueblo desde el SO, elevada.
  ['terrain_pueblo', { px: 2750, py: 210, pz: 3350, tx: 3097, ty: 80, tz: 3950 }],
  // Mirando hacia el norte / Montes de Oca desde el pueblo.
  ['terrain_montes', { px: 3097, py: 190, pz: 3450, tx: 1900, ty: 95, tz: 4300 }],
  // La sierra alta (esquina SO/NW), vista aérea.
  ['terrain_sierra', { px: 1150, py: 600, pz: 1150, tx: 450, ty: 320, tz: 400 }],
];

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
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text ?? 'evaluate error');
    return result.result.value;
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
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1280, height: 720, deviceScaleFactor: 1, mobile: false,
    });

    const measurements = [];
    for (const [name, view] of VIEWS) {
      const qs = view
        ? new URLSearchParams(Object.entries(view).map(([k, v]) => [k, String(v)])).toString()
        : '';
      const url = qs ? `${BASE}/?${qs}` : `${BASE}/`;
      console.log(`[capture] ${name} -> ${url}`);

      let hud = '';
      let lastShot = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        await cdp.send('Page.navigate', { url });
        await wait(1500);
        for (let i = 0; i < 90; i++) {
          hud = await cdp.evaluate("document.getElementById('hud')?.textContent ?? ''");
          if (hud.includes('triángulos') || hud.includes('ERROR')) break;
          await wait(1000);
        }
        lastShot = await cdp.send('Page.captureScreenshot', { format: 'png' });
        if (!hud.includes('ERROR')) break;
        console.log(`[capture] ${name}: reintento ${attempt + 1} (${hud.replace(/\n/g, ' ')})`);
        await wait(1200);
      }

      const file = resolve(OUT_DIR, `${name}.png`);
      writeFileSync(file, Buffer.from(lastShot.data, 'base64'));

      const tris = /triángulos\s+(\d+)/.exec(hud)?.[1] ?? null;
      const inView = /en vista\s+(\d+)/.exec(hud)?.[1] ?? null;
      const tiles = /tiles\s+(\d+)/.exec(hud)?.[1] ?? null;
      const camera = /cámara\s+(.+)/.exec(hud)?.[1] ?? null;
      measurements.push({ vista: name, url, tiles, triangulos: tris, triangulos_en_vista: inView, camara: camera, png: file });
      console.log(`[capture] ${name}: tiles=${tiles} tris=${tris} enVista=${inView} cam=${camera}`);
      if (hud.includes('ERROR')) console.log(`[capture] HUD ERROR:\n${hud}`);
    }

    writeFileSync(resolve(OUT_DIR, 'terrain_captures.json'), JSON.stringify(measurements, null, 2) + '\n');

    // Se vuelcan las mediciones REALES de la app dentro de budget.json.
    const budgetFile = resolve(root, 'public', 'terrain', 'budget.json');
    const budget = JSON.parse(readFileSync(budgetFile, 'utf8'));
    budget.medido_en_app = {
      descripcion:
        'Conteo real de la app (Chrome headless + CDP, HUD de Babylon) para las vistas capturadas. ' +
        '"triangulos_en_vista" es lo que reporta scene.getActiveIndices()/3.',
      capturas: measurements.map((m) => ({
        vista: m.vista,
        url: m.url,
        camara: m.camara,
        tiles_totales: m.tiles,
        triangulos_en_vista: m.triangulos_en_vista === null ? null : Number(m.triangulos_en_vista),
        png: `output/${m.vista}.png`,
      })),
    };
    writeFileSync(budgetFile, JSON.stringify(budget, null, 2) + '\n');

    console.log(`\n=> ${measurements.length} capturas en ${OUT_DIR}`);
    console.log(`=> mediciones volcadas en ${budgetFile} (medido_en_app)`);
  } finally {
    chrome.kill('SIGKILL');
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
