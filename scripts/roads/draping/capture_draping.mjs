// Medición y captura del DRAPEADO de la red vial sobre el terreno real.
// Chrome headless + CDP con el WebSocket nativo de Node (cero deps nuevas),
// mismo patrón que scripts/vehicle/capture_vehicle.mjs y
// scripts/terrain/capture_terrain.mjs.
//
// Mide, en la APP REAL:
//   1. residual cinta↔terreno (p50/p95/máx) con la fórmula script-side y
//      `window.__game.terrainHeightAt` (que usa la interpolación triangular);
//   2. si el borde libre del faldón ROAD llega al terreno;
//   3. draw calls y triángulos ANTES (?drape=0) y DESPUÉS (con vías);
//   4. FPS/frame (NO representativos: SwiftShader sin GPU, igual que FASE 4);
//   5. captura del 4x4 sobre una TRACK y sobre una ROAD;
//   6. vistas amplias y un caso de pendiente transversal fuerte.
//
// Uso: node scripts/roads/draping/capture_draping.mjs \
//        [--out-dir output] [--port 9225] [--base http://127.0.0.1:4173]
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..', '..');

const argv = process.argv.slice(2);
function arg(name, fallback) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
}
const PORT = Number(arg('--port', '9225'));
const BASE = arg('--base', 'http://127.0.0.1:4173');
const OUT_DIR = resolve(root, arg('--out-dir', 'output'));
const CHROME = arg('--chrome', 'google-chrome');
const PROFILE = '/tmp/opencode/chrome-cdp-profile-draping';
const SPAWN = { x: 3097.258, z: 3945.02 };

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

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

function summarize(values) {
  if (values.length === 0) return { count: 0, p50: 0, p95: 0, max: 0, mean: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  let sum = 0;
  for (const v of sorted) sum += v;
  return {
    count: sorted.length,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: sorted[sorted.length - 1],
    mean: sum / sorted.length,
  };
}

async function waitReady(cdp, requireVehicle) {
  const probe = requireVehicle ? '!!(window.__game && window.__game.vehicle)' : '!!(window.__game && window.__game.roads)';
  let ready = false;
  for (let i = 0; i < 120 && !ready; i++) {
    await wait(1000);
    try {
      ready = await cdp.evaluate(probe);
    } catch {
      ready = false;
    }
  }
  if (!ready) throw new Error(`la app no quedó lista (${probe})`);
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

    const report = {
      generado_por: 'scripts/roads/draping/capture_draping.mjs',
      base: BASE,
      fecha: new Date().toISOString(),
    };

    // ===================== 3. ANTES: sin vías (?drape=0) =====================
    console.log('[draping] ANTES: navegando a /?drape=0');
    await cdp.send('Page.navigate', { url: `${BASE}/?drape=0` });
    await waitReady(cdp, true);
    await wait(2500);
    const perfBefore = await cdp.evaluate('window.__game.perf()');
    report.perf_sin_vias = perfBefore;
    console.log(`[draping] sin vías: draw=${perfBefore.drawCalls} tris=${perfBefore.triangles.toFixed(0)} fps=${perfBefore.fps.toFixed(1)}`);

    // ===================== DESPUÉS: con vías =====================
    console.log('[draping] DESPUÉS: navegando a / (modo vehículo, con vías)');
    await cdp.send('Page.navigate', { url: `${BASE}/` });
    await waitReady(cdp, true);
    await wait(2500);

    report.stats = await cdp.evaluate('window.__game.roads.stats()');
    console.log(
      `[draping] stats: ${report.stats.roads} vías · ${report.stats.vertices} vértices · ` +
        `${report.stats.triangles} tris · ${report.stats.meshes} mallas`,
    );

    const perfAfter = await cdp.evaluate('window.__game.perf()');
    report.perf_con_vias = perfAfter;
    report.perf_nota =
      'FPS y frame time en Chrome headless con SwiftShader (CPU). NO representan el rendimiento en GPU. ' +
      'draw calls y triángulos sí son válidos.';
    report.costo_vias = {
      draw_calls_antes: perfBefore.drawCalls,
      draw_calls_despues: perfAfter.drawCalls,
      draw_calls_delta: perfAfter.drawCalls - perfBefore.drawCalls,
      triangulos_antes: perfBefore.triangles,
      triangulos_despues: perfAfter.triangles,
      triangulos_delta: Math.round(perfAfter.triangles - perfBefore.triangles),
    };
    console.log(
      `[draping] draw calls ${perfBefore.drawCalls} -> ${perfAfter.drawCalls} (+${perfAfter.drawCalls - perfBefore.drawCalls}) · ` +
        `tris ${perfBefore.triangles.toFixed(0)} -> ${perfAfter.triangles.toFixed(0)} (+${Math.round(perfAfter.triangles - perfBefore.triangles)})`,
    );

    // ===================== 1+2. Residual: app + verificación script-side =====================
    const audit = await cdp.evaluate('window.__game.roads.audit()');
    report.audit_app = audit;
    report.offset_m = audit.offsetM;
    report.tolerancia_m = audit.toleranceM;
    console.log(
      `[draping] auditoría app (offset ${JSON.stringify(audit.offsetM)} m): ` +
        Object.entries(audit.classes)
          .map(
            ([k, v]) =>
              `${k} pav p95=${v.pavement.p95.toExponential(2)} max=${v.pavement.max.toExponential(2)}` +
              (v.skirt ? ` | faldón max=${v.skirt.max.toExponential(2)}` : '') +
              (v.bridge ? ` | puente max=${v.bridge.max.toExponential(2)}` : ''),
          )
          .join('  '),
    );

    // Verificación independiente: la muestra la arma el script, la altura sale
    // de `terrainHeightAt` (interpolación triangular de la app). Se recorta al
    // dominio [0,6000] EXACTAMENTE como hace la app al construir: fuera de la
    // ventana `heightAt` devuelve el "0 absoluto" (−datum).
    const BOUND = 6000;
    const PROBE_N = 6000;
    const probes = await cdp.evaluate(`window.__game.roads.probe(${PROBE_N})`);
    const outOfBounds = probes.filter((p) => p.x < 0 || p.x > BOUND || p.z < 0 || p.z > BOUND).length;
    const terrainY = await cdp.evaluate(
      `(() => { const ps = ${JSON.stringify(probes)};
        return ps.map(p => window.__game.terrainHeightAt(
          Math.min(${BOUND}, Math.max(0, p.x)), Math.min(${BOUND}, Math.max(0, p.z)))); })()`,
    );
    const residuals = { byClassRole: {} };
    for (let i = 0; i < probes.length; i++) {
      const p = probes[i];
      const roleName = p.role === 1 ? 'faldon' : p.role === 2 ? 'puente' : 'calzada';
      const key = `${p.class}/${roleName}`;
      const r = Math.abs(p.y - (terrainY[i] + audit.offsetM[p.class]));
      (residuals.byClassRole[key] ??= []).push(r);
    }
    residuals.summary = Object.fromEntries(Object.entries(residuals.byClassRole).map(([k, v]) => [k, summarize(v)]));
    delete residuals.byClassRole;
    residuals.probe_count = probes.length;
    residuals.vertices_fuera_de_ventana = outOfBounds;
    residuals.clamp_nota =
      `Las coordenadas de muestreo se recortan a [0,${BOUND}] (mismo clamp que la app). ` +
      `Los vértices fuera de ventana (${outOfBounds} de ${probes.length}) reciben la cota del borde, no el "0 absoluto".`;
    report.residual_verificacion_independiente = residuals;
    console.log(
      '[draping] residual independiente: ' +
        Object.entries(residuals.summary)
          .map(([k, v]) => `${k} n=${v.count} p50=${v.p50.toExponential(2)} p95=${v.p95.toExponential(2)} max=${v.max.toExponential(2)}`)
          .join('\n              '),
    );

    // ===================== 7. Caso difícil: pendiente transversal =====================
    const trackStations = await cdp.evaluate(
      `window.__game.roads.stations().filter(s => s.class === ${JSON.stringify('TRACK')})`,
    );
    const minimal = trackStations.map((s) => [s.x, s.z, s.dx, s.dz]);
    const slopes = await cdp.evaluate(
      `(() => { const ss = ${JSON.stringify(minimal)}; return ss.map(s => {
        const n = window.__game.terrainNormalAt(s[0], s[1]);
        const gx = -n.x / n.y, gz = -n.z / n.y;
        return { cross: Math.abs(gx * (-s[3]) + gz * s[2]), fwd: Math.abs(gx * s[2] + gz * s[3]) };
      }); })()`,
    );
    let steepIndex = 0;
    let steepCross = -1;
    for (let i = 0; i < slopes.length; i++) {
      if (slopes[i].cross > steepCross) {
        steepCross = slopes[i].cross;
        steepIndex = i;
      }
    }
    const steep = trackStations[steepIndex];
    const steepDeg = (Math.atan(steepCross) * 180) / Math.PI;
    report.caso_dificil = {
      descripcion: 'Estación TRACK de mayor pendiente transversal (gradiente del terreno proyectado sobre la normal de la vía).',
      x: steep.x,
      z: steep.z,
      cross_slope_deg: steepDeg,
      fwd_slope_deg: (Math.atan(slopes[steepIndex].fwd) * 180) / Math.PI,
      yaw: Math.atan2(steep.dx, steep.dz),
    };
    console.log(`[draping] caso difícil TRACK: (${steep.x.toFixed(0)}, ${steep.z.toFixed(0)}) pendiente transversal ${steepDeg.toFixed(1)}°`);

    // ===================== Puntos de captura (TRACK / ROAD) =====================
    const allStations = await cdp.evaluate('window.__game.roads.stations()');
    let roadNear = null;
    let bestRoadD = Infinity;
    for (const s of allStations) {
      if (s.class !== 'ROAD') continue;
      const d = Math.hypot(s.x - SPAWN.x, s.z - SPAWN.z);
      if (d < bestRoadD) {
        bestRoadD = d;
        roadNear = s;
      }
    }
    // TRACK del NE (x>=3000, z>=3000) que no sea el caso extremo: se elige una
    // estación de pendiente fuerte pero manejable (10–16° de transversal).
    const trackNE = [];
    for (let i = 0; i < trackStations.length; i++) {
      const s = trackStations[i];
      if (s.x >= 3000 && s.z >= 3000) {
        const deg = (Math.atan(slopes[i].cross) * 180) / Math.PI;
        if (deg >= 8 && deg <= 16) trackNE.push({ s, deg });
      }
    }
    trackNE.sort((a, b) => Math.hypot(a.s.x - SPAWN.x, a.s.z - SPAWN.z) - Math.hypot(b.s.x - SPAWN.x, b.s.z - SPAWN.z));
    const trackPick = trackNE[0] ?? { s: trackStations[0], deg: 0 };
    report.puntos_captura = {
      road: { x: roadNear.x, z: roadNear.z, dist_al_spawn_m: bestRoadD, yaw: Math.atan2(roadNear.dx, roadNear.dz) },
      track: { x: trackPick.s.x, z: trackPick.s.z, cross_deg: trackPick.deg, yaw: Math.atan2(trackPick.s.dx, trackPick.s.dz) },
    };
    console.log(
      `[draping] ROAD más cercana al spawn: (${roadNear.x.toFixed(0)}, ${roadNear.z.toFixed(0)}) a ${bestRoadD.toFixed(1)} m · ` +
        `TRACK NE: (${trackPick.s.x.toFixed(0)}, ${trackPick.s.z.toFixed(0)}) transversal ${trackPick.deg.toFixed(1)}°`,
    );

    // ===================== Capturas con el 4x4 encima =====================
    async function captureOnVehicle(spot, file, label) {
      await cdp.evaluate(
        `(() => { const g = window.__game; g.vehicle.teleport(${spot.x}, ${spot.z}, ${spot.yaw}); g.vehicle.step(0.6, 1/120); })()`,
      );
      await wait(1400);
      await cdp.screenshot(resolve(OUT_DIR, file));
      const telemetry = await cdp.evaluate('window.__game.vehicle.telemetry()');
      const groundY = await cdp.evaluate(`window.__game.terrainHeightAt(${spot.x}, ${spot.z})`);
      console.log(
        `[draping] captura ${label}: output/${file} · y=${telemetry.y.toFixed(3)} terreno=${groundY.toFixed(3)} residual_ruedas=${telemetry.wheelResidualMaxM.toFixed(3)}`,
      );
      return { telemetry, ground_y: groundY };
    }

    report.captura_track = await captureOnVehicle(report.puntos_captura.track, 'roads_track.png', 'TRACK');
    report.captura_road = await captureOnVehicle(report.puntos_captura.road, 'roads_road.png', 'ROAD');
    report.captura_caso_dificil = await captureOnVehicle(
      { x: steep.x, z: steep.z, yaw: report.caso_dificil.yaw },
      'roads_pendiente_transversal.png',
      'pendiente transversal',
    );

    // ===================== Vista amplia (cámara libre) =====================
    const wideViews = [
      // Sobre el cuadrante NE, picado (~40°) para que el horizonte quede fuera
      // de cuadro: el culling del terreno es de 900 m, así que una vista que
      // incluya el horizonte mostraría vías lejanas sin terreno debajo.
      ['roads_vista_ne', { px: 3550, py: 620, pz: 4350, tx: 3150, ty: 60, tz: 3900 }],
      // El pueblo y su entorno, en picado desde el SO.
      ['roads_vista_pueblo', { px: 2800, py: 680, pz: 3350, tx: 3350, ty: 70, tz: 3900 }],
    ];
    for (const [name, view] of wideViews) {
      const qs = new URLSearchParams(Object.entries(view).map(([k, v]) => [k, String(v)])).toString();
      await cdp.send('Page.navigate', { url: `${BASE}/?${qs}` });
      await waitReady(cdp, false);
      await wait(2500);
      await cdp.screenshot(resolve(OUT_DIR, `${name}.png`));
      const perf = await cdp.evaluate('window.__game.perf()');
      console.log(`[draping] vista ${name}: draw=${perf.drawCalls} tris=${perf.triangles.toFixed(0)} -> output/${name}.png`);
    }

    writeFileSync(resolve(OUT_DIR, 'roads_draping.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(`\n=> mediciones y capturas en ${OUT_DIR}`);
  } finally {
    chrome.kill('SIGKILL');
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
