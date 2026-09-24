// Captura y medición del 4x4 EN LA APP REAL (Chrome headless + CDP, WebSocket
// nativo de Node). Cero dependencias nuevas: copia el patrón de
// scripts/terrain/capture_terrain.mjs.
//
// Usa la API de depuración `window.__game` que expone main.ts:
//   - teleport + step determinista (física fija) para medir;
//   - telemetría (velocidad, pendiente, residual de rueda, slipping);
//   - snapshots de rendimiento (FPS, frame, draw calls, triángulos).
//
// ADVERTENCIA: Chrome headless sin GPU (SwiftShader) NO es una medida válida de
// rendimiento del juego. FPS y frame time quedan registrados pero marcados como
// NO representativos; draw calls y triángulos sí son válidos.
//
// Uso: node scripts/vehicle/capture_vehicle.mjs [--out-dir output] [--port 9224] [--base http://127.0.0.1:4173]
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
const PORT = Number(arg('--port', '9224'));
const BASE = arg('--base', 'http://127.0.0.1:4173');
const OUT_DIR = resolve(root, arg('--out-dir', 'output'));
const CHROME = arg('--chrome', 'google-chrome');
const PROFILE = '/tmp/opencode/chrome-cdp-profile-vehicle';

// Puntos de interés (mundo). Ver docs/vehicle/VEHICLE_FASE4.md.
const SPAWN = { x: 3097.258, z: 3945.02 };
const SPOTS = [
  { name: 'spawn', x: 3097.258, z: 3945.02 },
  { name: 'fuerte_40', x: 3320, z: 3705 },
  { name: 'moderada_22', x: 3025, z: 3950 },
  { name: 'oeste_32', x: 2280, z: 4100 },
  { name: 'sur_40', x: 2690, z: 4350 },
  { name: 'este_40', x: 3685, z: 3365 },
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

    console.log(`[vehicle] navegando a ${BASE}/ (modo vehículo)`);
    await cdp.send('Page.navigate', { url: `${BASE}/` });

    // Espera a que el juego y el vehículo estén listos.
    let ready = false;
    for (let i = 0; i < 120 && !ready; i++) {
      await wait(1000);
      try {
        ready = await cdp.evaluate('!!(window.__game && window.__game.vehicle)');
      } catch {
        ready = false;
      }
    }
    if (!ready) throw new Error('window.__game.vehicle no estuvo listo (¿error al cargar?)');
    await wait(2500); // deja estabilizar render/culling

    const report = { generado_por: 'scripts/vehicle/capture_vehicle.mjs', base: BASE, fecha: new Date().toISOString() };

    // --- Auditoría del footgun de los dos heightAt en la app real ---
    report.datum_audit = await cdp.evaluate('window.__game.auditDatum()');
    console.log(`[vehicle] datum audit: diff_max=${report.datum_audit.maxAbsDiffM} ok=${report.datum_audit.ok}`);

    // --- Rendimiento (FPS/frame NO representativos: SwiftShader sin GPU) ---
    report.perf = await cdp.evaluate('window.__game.perf()');
    report.perf_nota =
      'FPS y frame time medidos en Chrome headless con SwiftShader (CPU). NO representan el rendimiento del juego en GPU. ' +
      'draw calls y triángulos sí son válidos.';
    console.log(`[vehicle] perf (no representativo): fps=${report.perf.fps.toFixed(0)} frame=${report.perf.frameTimeMs.toFixed(1)}ms draw=${report.perf.drawCalls} tris=${report.perf.triangles.toFixed(0)}`);

    // --- Contacto: residual rueda-terreno en varios puntos ---
    report.contacto = [];
    for (const spot of SPOTS) {
      const t = await cdp.evaluate(`(() => {
        const g = window.__game;
        g.vehicle.teleport(${spot.x}, ${spot.z}, 0);
        g.vehicle.step(0.5, 1/120);
        return g.vehicle.telemetry();
      })()`);
      report.contacto.push({ punto: spot.name, x: spot.x, z: spot.z, residual_max_m: t.wheelResidualMaxM, y: t.y, contacts: t.contacts });
      console.log(`[vehicle] contacto ${spot.name}: residual=${t.wheelResidualMaxM.toFixed(4)} m`);
    }

    // --- Captura 1: el 4x4 parado en el spawn ---
    await cdp.evaluate(`(() => { window.__game.vehicle.teleport(${SPAWN.x}, ${SPAWN.z}, 0); window.__game.vehicle.step(0.5); })()`);
    await wait(700);
    await cdp.screenshot(resolve(OUT_DIR, 'vehicle_spawn.png'));
    report.captura_spawn = await cdp.evaluate('window.__game.vehicle.telemetry()');
    console.log(`[vehicle] captura spawn -> output/vehicle_spawn.png`);

    // --- Captura 2: subiendo una pendiente fuerte DE COSTADO (para ver alabeo) ---
    const slopeInfo = await cdp.evaluate(`(() => {
      const g = window.__game;
      const n = g.terrainNormalAt(3320, 3705);
      const gE = -n.x / n.y, gN = -n.z / n.y;
      return { upYaw: Math.atan2(gE, gN), slopeDeg: Math.atan(Math.hypot(gE, gN)) * 180 / Math.PI };
    })()`);
    const sideYaw = slopeInfo.upYaw + Math.PI / 2;
    const t2 = await cdp.evaluate(`(() => {
      const g = window.__game;
      g.vehicle.teleport(3320, 3705, ${sideYaw});
      g.vehicle.setInput({ throttle: 0.5, steer: 0, handbrake: false, neutral: false });
      g.vehicle.step(1.0, 1/120);
      return g.vehicle.telemetry();
    })()`);
    await wait(700);
    await cdp.screenshot(resolve(OUT_DIR, 'vehicle_pendiente.png'));
    report.captura_pendiente = { slopeDeg: slopeInfo.slopeDeg, telemetry: t2 };
    console.log(`[vehicle] captura pendiente ${slopeInfo.slopeDeg.toFixed(1)}° de costado -> output/vehicle_pendiente.png (alabeo ${t2.rollDeg.toFixed(1)}°)`);

    // --- Captura 3: intento de subida de frente al 40° desde parado ---
    const t3 = await cdp.evaluate(`(() => {
      const g = window.__game;
      const n = g.terrainNormalAt(3320, 3705);
      const yaw = Math.atan2(-n.x / n.y, -n.z / n.y);
      g.vehicle.teleport(3320, 3705, yaw);
      g.vehicle.setInput({ throttle: 1, steer: 0, handbrake: false, neutral: false });
      g.vehicle.step(10, 1/120);
      return g.vehicle.telemetry();
    })()`);
    await wait(500);
    await cdp.screenshot(resolve(OUT_DIR, 'vehicle_traccion.png'));
    report.intento_subida_40 = t3;
    console.log(`[vehicle] intento subida 40°: v=${t3.speed.toFixed(2)} m/s slipping=${t3.slipping} -> output/vehicle_traccion.png`);

    // --- Curva de arranque en pendiente moderada (aporte a "sentir la pendiente") ---
    report.arranque_moderada = await cdp.evaluate(`(() => {
      const g = window.__game;
      const n = g.terrainNormalAt(3025, 3950);
      const yaw = Math.atan2(-n.x / n.y, -n.z / n.y);
      g.vehicle.teleport(3025, 3950, yaw);
      g.vehicle.setInput({ throttle: 1, steer: 0, handbrake: false, neutral: false });
      const samples = [];
      for (let i = 0; i < 10; i++) { g.vehicle.step(0.5, 1/120); const t = g.vehicle.telemetry(); samples.push({ t: (i + 1) * 0.5, v: t.speed, slope: t.slopeForwardDeg }); }
      return samples;
    })()`);

    // --- Bajada en punto muerto en la app (plano real) ---
    report.bajada_app = await cdp.evaluate(`(() => {
      const g = window.__game;
      const n = g.terrainNormalAt(3025, 3950);
      const downYaw = Math.atan2(n.x / n.y, n.z / n.y); // gradiente negativo
      g.vehicle.teleport(3025, 3950, downYaw);
      g.vehicle.setInput({ throttle: 0, steer: 0, handbrake: false, neutral: true });
      const samples = [];
      for (let i = 0; i < 6; i++) { g.vehicle.step(0.5, 1/120); const t = g.vehicle.telemetry(); samples.push({ t: (i + 1) * 0.5, v: t.speed, slope: t.slopeForwardDeg }); }
      return samples;
    })()`);

    writeFileSync(resolve(OUT_DIR, 'vehicle_captures.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(`\n=> capturas y mediciones en ${OUT_DIR}`);
  } finally {
    chrome.kill('SIGKILL');
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
