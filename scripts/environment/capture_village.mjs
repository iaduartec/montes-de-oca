// Captura y medicion de la capa de PUEBLO (Chrome headless + CDP con el
// WebSocket nativo de Node). Cero dependencias nuevas: mismo patron que
// scripts/vehicle/capture_vehicle.mjs y scripts/roads/draping/capture_draping.mjs.
//
// Mide y fotografía:
//   1. `window.__game.perf()` ANTES (mallas del pueblo desactivadas) y DESPUES,
//      en la MISMA escena y con la misma camara: el delta es el costo del pueblo.
//   2. `villageAudit()`: base REAL de las mallas contra `terrain.heightAt`
//      (esta es la prueba de que ninguna casa flota).
//   3. Captura a nivel de calle desde la aparicion y picado aereo del casco.
//   4. Filtro de spawn con radio agrandado (`?keepclear=40`) para demostrar que
//      `droppedAtSpawn` cuenta lo que dice contar y no un cero por casualidad.
//
// ADVERTENCIA: FPS/frame en headless con SwiftShader NO es senal de rendimiento.
// Draw calls y triangulos si lo son.
//
// El harness es un HTML que solo existe en el dev server (main.ts esta congelado
// para este worker):  npm run dev  y despues
//   node scripts/environment/capture_village.mjs --base http://127.0.0.1:5174
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
const BASE = arg('--base', 'http://127.0.0.1:5174');
const OUT_DIR = resolve(root, arg('--out-dir', 'output/milestone1'));
const CHROME = arg('--chrome', 'google-chrome');
const PROFILE = '/tmp/opencode/chrome-cdp-profile-village';
const PREVIEW = `${BASE}/scripts/environment/village_preview.html`;

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
      generado_por: 'scripts/environment/capture_village.mjs',
      base: BASE,
      fecha: new Date().toISOString(),
    };

    // ---------------------------------------------------- 1. vista de calle
    console.log(`[pueblo] navegando a ${PREVIEW}?view=street`);
    await cdp.send('Page.navigate', { url: `${PREVIEW}?view=street` });
    await waitReady(cdp);
    await wait(2500);

    report.stats = await cdp.evaluate('window.__game.villageStats()');
    console.log(
      `[pueblo] stats: ${report.stats.buildings} casas · ${report.stats.meshes} mallas · ` +
        `${report.stats.triangles} triángulos · ${report.stats.footprintAreaM2} m² · ` +
        `más alto ${report.stats.tallestM} m · descartados en spawn ${report.stats.droppedAtSpawn}`,
    );

    // ---------------------------------------------------- 2. antes / despues
    const perfAfter = await cdp.evaluate('window.__game.perf()');
    await cdp.evaluate('window.__game.setVillageEnabled(false)');
    await wait(1200);
    const perfBefore = await cdp.evaluate('window.__game.perf()');
    await cdp.evaluate('window.__game.setVillageEnabled(true)');
    await wait(1200);
    report.perf_con_pueblo = perfAfter;
    report.perf_sin_pueblo = perfBefore;
    report.costo_pueblo = {
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
      `[pueblo] draw calls ${perfBefore.drawCalls} -> ${perfAfter.drawCalls} ` +
        `(+${perfAfter.drawCalls - perfBefore.drawCalls}) · tris ${perfBefore.triangles.toFixed(0)} -> ` +
        `${perfAfter.triangles.toFixed(0)} (+${Math.round(perfAfter.triangles - perfBefore.triangles)})`,
    );

    // ---------------------------------------------------- 3. base sin flotar
    report.audit = await cdp.evaluate('window.__game.villageAudit()');
    console.log(
      `[pueblo] auditoría de base: ${report.audit.sample} edificios muestreados · ` +
        `gap máx ${report.audit.maxGapM.toFixed(4)} m (peor #${report.audit.worstId}) · ` +
        `sin malla ${report.audit.missing} => ${report.audit.ok ? 'OK' : 'FALLA'}`,
    );
    if (!report.audit.ok) throw new Error('la auditoria de base fallo: hay casas flotando');

    // ---------------------------------------------------- 4. capturas
    await cdp.evaluate('window.__game.setView("street")');
    await wait(900);
    await cdp.screenshot(resolve(OUT_DIR, '10_village_street.png'));
    console.log('[pueblo] captura calle -> output/milestone1/10_village_street.png');

    await cdp.evaluate('window.__game.setView("aerial")');
    await wait(900);
    await cdp.screenshot(resolve(OUT_DIR, '11_village_aerial.png'));
    console.log('[pueblo] captura aérea -> output/milestone1/11_village_aerial.png');

    // ------------------------------------------ 5. estres del filtro de spawn
    // El JSON ya viene limpio (el build descarta lo que invada 12 m), asi que con
    // el radio por defecto `droppedAtSpawn` da 0. Con 40 m se ve que el filtro
    // DEL RUNTIME hace lo que promete y no cuenta cero por casualidad.
    console.log(`[pueblo] re-navegando con ?keepclear=40 para estresar el filtro`);
    await cdp.send('Page.navigate', { url: `${PREVIEW}?view=street&keepclear=40` });
    await waitReady(cdp);
    await wait(2500);
    const stressed = await cdp.evaluate('window.__game.villageStats()');
    report.filtro_spawn_estres = {
      radio_m: 40,
      droppedAtSpawn: stressed.droppedAtSpawn,
      buildings_restantes: stressed.buildings,
      esperado: '> 0 (con 12 m los datos ya vienen limpios: 0)',
    };
    console.log(
      `[pueblo] filtro con radio 40 m: droppedAtSpawn=${stressed.droppedAtSpawn} · ` +
        `quedan ${stressed.buildings} casas => ${stressed.droppedAtSpawn > 0 ? 'OK' : 'FALLA'}`,
    );
    if (!(stressed.droppedAtSpawn > 0)) throw new Error('el filtro de spawn no descarto nada con radio 40 m');

    writeFileSync(resolve(OUT_DIR, 'village_captures.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(`\n=> capturas y mediciones en ${OUT_DIR}`);
  } finally {
    chrome.kill('SIGKILL');
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
