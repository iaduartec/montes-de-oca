// Captura y medicion de la capa de VEGETACION (Chrome headless + CDP con el
// WebSocket nativo de Node). Cero dependencias nuevas: mismo patron que
// scripts/environment/capture_village.mjs y scripts/roads/draping/capture_draping.mjs.
//
// Mide y fotografía:
//   1. `window.__game.perf()` ANTES (mallas de vegetacion desactivadas) y
//      DESPUES, en la MISMA escena y con la misma camara: el delta es el costo
//      real de la capa en draw calls y triangulos.
//   2. `vegetationStats()` del contrato (instancias, mallas, bandas de LOD).
//   3. Captura aerea sobre el bosque y captura a nivel de suelo sobre la pista
//      cerca del objetivo: las dos preguntas de la tarea son "¿se ve bosque?"
//      y "¿hay arboles en la pista / flotando?".
//
// ADVERTENCIA: FPS/frame en headless con SwiftShader NO es senal de rendimiento.
// Draw calls y triangulos si lo son.
//
// El harness es un HTML que solo existe en el dev server (main.ts esta congelado
// para este worker):  npm run dev  y despues
//   node scripts/environment/capture_vegetation.mjs --base http://127.0.0.1:5174
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
const PORT = Number(arg('--port', '9227'));
const BASE = arg('--base', 'http://127.0.0.1:5174');
const OUT_DIR = resolve(root, arg('--out-dir', 'output/milestone1'));
const CHROME = arg('--chrome', 'google-chrome');
const PROFILE = '/tmp/opencode/chrome-cdp-profile-vegetation';
const PREVIEW = `${BASE}/scripts/environment/vegetation_preview.html`;

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

async function waitReady(cdp) {
  for (let i = 0; i < 180; i++) {
    await wait(1000);
    try {
      if (await cdp.evaluate('!!(window.__game && window.__game.ready)')) return;
    } catch {
      /* la pagina sigue cargando */
    }
  }
  throw new Error('el preview no quedo listo (window.__game.ready)');
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
    if (!version) throw new Error('Chrome no abrio el puerto de depuracion');

    const tab = await fetchJson(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' });
    const cdp = await connect(tab.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });

    const report = {
      generado_por: 'scripts/environment/capture_vegetation.mjs',
      base: BASE,
      fecha: new Date().toISOString(),
    };

    // ---------------------------------------------------- 1. vista aerea
    console.log(`[vegetacion] navegando a ${PREVIEW}?view=aerial`);
    await cdp.send('Page.navigate', { url: `${PREVIEW}?view=aerial` });
    await waitReady(cdp);
    await wait(3000);

    report.stats = await cdp.evaluate('window.__game.vegetationStats()');
    if (report.stats) {
      console.log(
        `[vegetacion] stats: ${report.stats.instances} instancias · ${report.stats.trees} árboles · ` +
          `${report.stats.shrubs} arbustos · ${report.stats.grassTufts} matas · ${report.stats.meshes} mallas · ` +
          `tier ${report.stats.near}/${report.stats.mid}/${report.stats.far} · ` +
          `excluidas en runtime ${report.stats.excludedByCorridor}`,
      );
    } else {
      throw new Error('vegetationStats() devolvio null: la capa no cargo');
    }

    // ---------------------------------------------------- 2. antes / despues
    // Misma escena, misma camara: se apagan solo las mallas `veg:`. El delta de
    // draw calls es el costo real de la capa.
    const perfAfter = await cdp.evaluate('window.__game.perf()');
    await cdp.evaluate('window.__game.setVegetationEnabled(false)');
    await wait(1500);
    const perfBefore = await cdp.evaluate('window.__game.perf()');
    await cdp.evaluate('window.__game.setVegetationEnabled(true)');
    await wait(1500);
    report.perf_con_vegetacion = perfAfter;
    report.perf_sin_vegetacion = perfBefore;
    report.costo_vegetacion = {
      draw_calls_antes: perfBefore.drawCalls,
      draw_calls_despues: perfAfter.drawCalls,
      draw_calls_delta: perfAfter.drawCalls - perfBefore.drawCalls,
      triangulos_antes: perfBefore.triangles,
      triangulos_despues: perfAfter.triangles,
      triangulos_delta: Math.round(perfAfter.triangles - perfBefore.triangles),
    };
    report.nota_rendimiento =
      'FPS y frame time en Chrome headless con SwiftShader (CPU): NO representativos. ' +
      'Draw calls y triangulos si lo son.';
    console.log(
      `[vegetacion] draw calls ${perfBefore.drawCalls} -> ${perfAfter.drawCalls} ` +
        `(+${perfAfter.drawCalls - perfBefore.drawCalls}) · tris ${perfBefore.triangles.toFixed(0)} -> ` +
        `${perfAfter.triangles.toFixed(0)} (+${Math.round(perfAfter.triangles - perfBefore.triangles)})`,
    );

    // ---------------------------------------------------- 3. capturas
    await cdp.evaluate('window.__game.setView("aerial")');
    await wait(1200);
    await cdp.screenshot(resolve(OUT_DIR, '08_vegetation_aerial.png'));
    console.log('[vegetacion] captura aérea -> output/milestone1/08_vegetation_aerial.png');

    await cdp.evaluate('window.__game.setView("ground")');
    await wait(1200);
    await cdp.screenshot(resolve(OUT_DIR, '09_vegetation_ground.png'));
    console.log('[vegetacion] captura suelo -> output/milestone1/09_vegetation_ground.png');

    // ---------------------------------- 4. vista extra: claro de aparicion
    await cdp.evaluate('window.__game.setView("spawn")');
    await wait(1200);
    await cdp.screenshot(resolve(OUT_DIR, '08b_vegetation_spawn.png'));
    console.log('[vegetacion] captura claro -> output/milestone1/08b_vegetation_spawn.png');

    writeFileSync(resolve(OUT_DIR, 'vegetation_captures.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(`\n=> capturas y mediciones en ${OUT_DIR}`);
  } finally {
    chrome.kill('SIGKILL');
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
