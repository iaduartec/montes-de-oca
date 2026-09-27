// Arnés de la milestone 1: juega VILLAFRANCA -> PISTA -> OBJETIVO -> REGRESO
// de punta a punta en la APP REAL, sin Playwright y sin dependencias nuevas.
//
// Patrón copiado de scripts/vehicle/capture_vehicle.mjs y
// scripts/roads/draping/capture_draping.mjs: Chrome headless + CDP con el
// WebSocket nativo de Node.
//
// Diferencia clave con esos scripts: acá NO se teleporta para "parecer" que se
// jugó. Se conduce con pure-pursuit sobre `route.polyline` y se avanza el mundo
// Y LA MISIÓN con `player.inject(...)` + `player.step(seconds, dt)`.
//
// Uso:
//   node scripts/milestone/drive_milestone.mjs \
//     [--out-dir output/milestone1] [--port 4183] [--base http://127.0.0.1:4183] \
//     [--budget-s 300] [--cdp-port <libre>] [--chrome google-chrome] [--no-build] \
//     [--block-vegetation]
//
// Falla ruidosamente: si no llega al objetivo dentro de --budget-s reporta la
// distancia restante y la última pose; si queda atascado (>5 s simulados por
// debajo de 0,5 m/s) corta con la pose donde se clavó. Salir 0 exige TODOS los
// checks en verde y cero errores de consola.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');

const argv = process.argv.slice(2);
function arg(name, fallback) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
}
const flag = (name) => argv.includes(name);
const OUT_DIR = resolve(root, arg('--out-dir', 'output/milestone1'));
const PORT = Number(arg('--port', '4183'));
const BASE = arg('--base', `http://127.0.0.1:${PORT}`);
const BUDGET_S = Number(arg('--budget-s', '300'));
const CHROME = arg('--chrome', 'google-chrome');
const DO_BUILD = !flag('--no-build');
const BLOCK_VEGETATION = flag('--block-vegetation');
const LOG_PREFIX = '[milestone]';

// Los valores de diseño del bucle salen de src/gameplay/mission.ts (no se
// adivinan): reachRadiusM = 25, repairSeconds = 2. Se leen del snapshot real.
const ASSUMED_REACH_RADIUS_M = 25;

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchOk(url, init) {
  try {
    const res = await fetch(url, init);
    return res.ok ? res : null;
  } catch {
    return null;
  }
}
async function fetchJson(url, init) {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

function freePort() {
  return new Promise((res, rej) => {
    const srv = net.createServer();
    srv.once('error', rej);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => res(port));
    });
  });
}
function portFree(port) {
  return new Promise((res) => {
    const srv = net.createServer();
    srv.once('error', () => res(false));
    srv.listen(port, '127.0.0.1', () => srv.close(() => res(true)));
  });
}

function run(cmd, args) {
  return new Promise((res, rej) => {
    const child = spawn(cmd, args, { cwd: root, stdio: 'inherit' });
    child.on('error', rej);
    child.on('exit', (code) => (code === 0 ? res() : rej(new Error(`${cmd} ${args.join(' ')} -> exit ${code}`))));
  });
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.errors = [];
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params?.exceptionDetails;
        this.errors.push(`exceptionThrown: ${d?.exception?.description ?? d?.text ?? 'desconocida'}`);
      }
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params?.type === 'error') {
        const text = (msg.params.args ?? []).map((a) => a.value ?? a.description ?? a.type).join(' ');
        this.errors.push(`console.error: ${text}`);
      }
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

// ---------------------------------------------------------------------------
// Código que corre DENTRO de la página: el seguidor de ruta y las mediciones.
// Se evalúa una sola vez; el loop pesado (miles de `player.step`) corre acá
// adentro para no hacer un round-trip CDP por frame.
// ---------------------------------------------------------------------------
const HARNESS_SOURCE = `
window.__harness = (function () {
  var g = window.__game;
  var R = g.route;
  var DT = 1 / 60;

  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function wrap(a) { return Math.atan2(Math.sin(a), Math.cos(a)); }

  function makeTrack(points) {
    var pts = points.map(function (p) { return { x: p.x, z: p.z }; });
    var cum = [0];
    for (var i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z));
    return { pts: pts, cum: cum, total: cum[cum.length - 1] };
  }
  var fwd = makeTrack(R.polyline);
  var bwd = makeTrack(R.polyline.slice().reverse());

  function closest(track, x, z) {
    var best = { s: 0, dist: Infinity, px: track.pts[0].x, pz: track.pts[0].z };
    for (var i = 1; i < track.pts.length; i++) {
      var a = track.pts[i - 1], b = track.pts[i];
      var dx = b.x - a.x, dz = b.z - a.z;
      var len2 = dx * dx + dz * dz;
      var t = len2 > 0 ? ((x - a.x) * dx + (z - a.z) * dz) / len2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      var px = a.x + dx * t, pz = a.z + dz * t;
      var d = Math.hypot(x - px, z - pz);
      if (d < best.dist) best = { s: track.cum[i - 1] + Math.sqrt(len2) * t, dist: d, px: px, pz: pz };
    }
    return best;
  }
  function pointAtS(track, s) {
    s = clamp(s, 0, track.total);
    var lo = 0, hi = track.cum.length - 1;
    while (lo < hi - 1) { var mid = (lo + hi) >> 1; if (track.cum[mid] <= s) lo = mid; else hi = mid; }
    var a = track.pts[lo], b = track.pts[Math.min(lo + 1, track.pts.length - 1)];
    var seg = track.cum[lo + 1] !== undefined ? track.cum[lo + 1] - track.cum[lo] : 0;
    var t = seg > 0 ? (s - track.cum[lo]) / seg : 0;
    return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t, yaw: Math.atan2(b.x - a.x, b.z - a.z) };
  }

  // Conduce con pure-pursuit hasta (stopS | stopPoint | stopState | maxSim).
  function drive(o) {
    o = o || {};
    var track = o.reverse ? bwd : fwd;
    var maxSim = o.maxSim != null ? o.maxSim : 60;
    var vBase = o.vTarget != null ? o.vTarget : 15;
    var stopS = o.stopS != null ? o.stopS : Infinity;
    var stopPoint = o.stopPoint || null;
    var stopRadius = o.stopRadius != null ? o.stopRadius : 25;
    var stopStates = o.stopStates || null;
    var stuckLimit = o.stuckS != null ? o.stuckS : 5;
    var sim = 0, frames = 0, stuckS = 0, reason = 'maxSim';
    var slopes = [], speedSum = 0, speedMax = 0, resSum = 0, resMax = 0, air = 0, slip = 0, skid = 0;
    var lateralMax = 0, lateralSum = 0;
    var minDistStop = Infinity;
    while (sim < maxSim) {
      var t = g.vehicle.telemetry();
      var proj = closest(track, t.x, t.z);
      var snap = g.mission.snapshot();
      if (proj.dist > lateralMax) lateralMax = proj.dist;
      lateralSum += proj.dist;
      if (proj.s >= stopS) { reason = 'stopS'; break; }
      if (stopPoint) {
        var dp = Math.hypot(t.x - stopPoint.x, t.z - stopPoint.z);
        if (dp < minDistStop) minDistStop = dp;
        if (dp <= stopRadius) { reason = 'stopPoint'; break; }
      }
      if (stopStates && stopStates.indexOf(snap.state) >= 0) { reason = 'stopState'; break; }
      var v = t.speed, sfd = t.slopeForwardDeg;
      var vTarget = vBase;
      if (sfd < -8) vTarget = Math.max(6, vBase + (sfd + 8));
      if (sfd > 13) vTarget = Math.max(7, vBase - (sfd - 13) * 0.8);
      if (stopPoint) {
        var dpB = Math.hypot(t.x - stopPoint.x, t.z - stopPoint.z);
        vTarget = Math.min(vTarget, Math.max(2, dpB * 0.6));
      }
      var lookahead = clamp(12 + 0.7 * v, 12, 25);
      var tp = pointAtS(track, proj.s + lookahead);
      var desiredYaw = Math.atan2(tp.x - t.x, tp.z - t.z);
      var err = wrap(desiredYaw - (t.yawDeg * Math.PI) / 180);
      var throttle = clamp((vTarget - v) / 4, -1, 1);
      var steer = clamp(err / 0.6, -1, 1);
      // Error de rumbo grande: NO reversa. Antes se mandaba throttle=-1, que a
      // baja velocidad es REVERSA: el coche se iba de cola, entraba en
      // oscilación y terminaba derrapando a 80 m/s fuera de la ruta. Si viene
      // rápido, frena; si está lento, avanza despacio con la dirección a fondo.
      if (Math.abs(err) > 1.2) {
        steer = err > 0 ? 1 : -1;
        throttle = v > 3 ? -1 : 0.5;
      }
      if (v > (o.vMax != null ? o.vMax : 18)) throttle = -1; // tope duro de control
      if (v < 0 && throttle <= 0) throttle = 0; // no alimentar reversa
      g.player.inject({ throttle: throttle, steer: steer, handbrake: false, neutral: false });
      g.player.step(DT, DT);
      var t2 = g.vehicle.telemetry();
      sim += DT; frames++;
      var sp = Math.abs(t2.speed);
      speedSum += sp; if (sp > speedMax) speedMax = sp;
      slopes.push(t2.slopeForwardDeg);
      var rr = t2.wheelResidualMaxM; resSum += rr; if (rr > resMax) resMax = rr;
      if (t2.airborne) air++;
      if (t2.slipping) slip++;
      if (t2.skidding) skid++;
      if (sp < 0.5) stuckS += DT; else stuckS = 0;
      if (stuckS > stuckLimit) { reason = 'stuck'; break; }
    }
    var tf = g.vehicle.telemetry();
    var snapF = g.mission.snapshot();
    var projF = closest(track, tf.x, tf.z);
    var sorted = slopes.slice().sort(function (a, b) { return a - b; });
    function pct(p) { return sorted.length ? sorted[Math.floor(p * (sorted.length - 1))] : 0; }
    return {
      reason: reason, simSeconds: sim, frames: frames, projS: projF.s, trackTotal: track.total,
      missionState: snapF.state, distanceToTargetM: snapF.distanceToTargetM, distanceToReturnM: snapF.distanceToReturnM,
      minDistToStopPoint: minDistStop === Infinity ? null : minDistStop,
      final: { x: tf.x, z: tf.z, y: tf.y, speed: tf.speed, yawDeg: tf.yawDeg, slopeForwardDeg: tf.slopeForwardDeg,
               wheelResidualMaxM: tf.wheelResidualMaxM, airborne: tf.airborne, contacts: tf.contacts },
      stats: { meanSpeed: frames ? speedSum / frames : 0, maxSpeed: speedMax, p50SlopeDeg: pct(0.5), p95SlopeDeg: pct(0.95),
               maxSlopeDeg: sorted.length ? sorted[sorted.length - 1] : 0, meanResidualM: frames ? resSum / frames : 0,
               maxResidualM: resMax, airborneFrames: air, slippingFrames: slip, skiddingFrames: skid,
               maxLateralM: lateralMax, meanLateralM: frames ? lateralSum / frames : 0,
               skiddingFraction: frames ? skid / frames : 0 }
    };
  }

  // Camina hacia (x,z) con input relativo al MUNDO (forward=+Z, strafe=+X).
  function walk(o) {
    o = o || {};
    var maxSim = o.maxSim != null ? o.maxSim : 60;
    var tx = o.x, tz = o.z, stopDist = o.stopDist != null ? o.stopDist : 3;
    var sim = 0, reason = 'maxSim';
    while (sim < maxSim) {
      var t = g.player.telemetry();
      if (Math.hypot(t.x - tx, t.z - tz) <= stopDist) { reason = 'arrived'; break; }
      if (o.stopOnCanEnter && t.canEnter) { reason = 'canEnter'; break; }
      var dx = tx - t.x, dz = tz - t.z, mag = Math.hypot(dx, dz) || 1;
      g.player.inject({ forward: dz / mag, strafe: dx / mag, run: !!o.run });
      g.player.step(DT, DT);
      sim += DT;
    }
    return { reason: reason, simSeconds: sim, telemetry: g.player.telemetry(), mission: g.mission.snapshot() };
  }

  // Mantiene E. Devuelve el punto donde el estado llega a REPAIRED (o corta).
  function holdInteract(seconds) {
    g.player.inject({ interact: true, forward: 0, strafe: 0, run: false });
    var sim = 0, samples = [];
    while (sim < seconds) {
      g.player.step(DT, DT);
      sim += DT;
      var s = g.mission.snapshot();
      if (Math.abs(sim - Math.round(sim * 5) / 5) < DT / 2) samples.push({ t: +sim.toFixed(2), progress: +s.repairProgress.toFixed(3), state: s.state });
      if (s.state === 'REPAIRED') break;
    }
    g.player.inject({});
    return { simSeconds: sim, mission: g.mission.snapshot(), samples: samples };
  }

  // Prueba que reparar DESDE EL COCHE no funciona: mira y mantiene E a bordo.
  function repairFromCar(seconds) {
    var start = g.mission.snapshot();
    g.player.inject({ interact: true, throttle: 0, steer: 0, handbrake: true, neutral: false });
    var sim = 0;
    while (sim < seconds) { g.player.step(DT, DT); sim += DT; }
    g.player.inject({});
    var end = g.mission.snapshot();
    return {
      startState: start.state, endState: end.state, startProgress: start.repairProgress,
      endProgress: end.repairProgress, simSeconds: sim, distanceToTargetM: end.distanceToTargetM
    };
  }

  // Simetría acelerar/frenar en un punto de pendiente longitudinal ~0 (se elige
  // la guiñada perpendicular al gradiente). Mismo estado inicial en ambos casos.
  function measureSymmetry(x, z) {
    var n = g.terrainNormalAt(x, z);
    var ny = Math.max(n.y, 1e-6);
    var yaw = Math.atan2(-(-n.z / ny), -n.x / ny);
    function trial(throttle) {
      g.player.teleport(x, z, yaw);
      g.vehicle.setState({ speed: 5 });
      g.player.inject({ throttle: throttle, steer: 0, handbrake: false, neutral: false });
      g.player.step(1.0, DT);
      var t = g.vehicle.telemetry();
      return { speed: t.speed, slopeForwardDeg: t.slopeForwardDeg };
    }
    var accel = trial(1);
    var brake = trial(-1);
    return {
      x: x, z: z, yawDeg: (yaw * 180) / Math.PI, slopeForwardDeg: accel.slopeForwardDeg,
      fromSpeed: 5, toSpeedThrottle: accel.speed, toSpeedBrake: brake.speed,
      aThrottle: accel.speed - 5, aBrake: brake.speed - 5,
      delta: accel.speed - 5 - (5 - brake.speed)
    };
  }

  return {
    tracks: { forwardM: fwd.total, backwardM: bwd.total },
    drive: drive, walk: walk, holdInteract: holdInteract,
    repairFromCar: repairFromCar, measureSymmetry: measureSymmetry,
    closest: function (x, z, reverse) { return closest(reverse ? bwd : fwd, x, z); }
  };
})();
'ok';
`;

// ---------------------------------------------------------------------------
// Orquestación Node
// ---------------------------------------------------------------------------
async function ensureServer(log) {
  const alive = await fetchOk(`${BASE}/`);
  if (alive) {
    log(`reutiliza server ya vivo en ${BASE}`);
    return null;
  }
  if (!(await portFree(PORT))) throw new Error(`el puerto ${PORT} está ocupado por otro proceso; elegí otro --port`);
  if (DO_BUILD) {
    log('build previo (npm run build)...');
    await run('npm', ['run', 'build']);
  }
  log(`levantando vite preview en ${BASE}`);
  const child = spawn('npx', ['vite', 'preview', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], {
    cwd: root,
    stdio: 'ignore',
    detached: true,
  });
  for (let i = 0; i < 60; i++) {
    await wait(500);
    if (await fetchOk(`${BASE}/`)) return child;
  }
  child.kill('SIGKILL');
  throw new Error(`vite preview no respondió en ${BASE}`);
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const report = {
    generado_por: 'scripts/milestone/drive_milestone.mjs',
    base: BASE,
    out_dir: OUT_DIR,
    budget_s: BUDGET_S,
    fecha: new Date().toISOString(),
    checks: [],
    errores_consola: [],
    capturas: [],
    notas: [
      'FPS/frame medidos en Chrome headless con SwiftShader (CPU): NO son señal de rendimiento.',
      'draw calls y triángulos sí son válidos. El FPS real se mide en la GPU del usuario a 1920x1080 (objetivo ~60 fps RTX 2070).',
    ],
  };
  const log = (...a) => console.log(LOG_PREFIX, ...a);
  const checks = report.checks;
  function check(name, ok, value, threshold, detail) {
    checks.push({ name, ok: !!ok, value, threshold, ...(detail !== undefined ? { detail } : {}) });
    log(`${ok ? 'PASS' : 'FAIL'}  ${name}  (valor=${JSON.stringify(value)} umbral=${JSON.stringify(threshold)})${detail !== undefined ? ' ' + JSON.stringify(detail) : ''}`);
  }

  let serverChild = null;
  let chrome = null;
  let exitCode = 1;
  /** Se hoistea para que el `catch` pueda volcar los errores capturados al reporte. */
  let cdp = null;
  try {
    serverChild = await ensureServer(log);

    const cdpPort = Number(arg('--cdp-port', '')) || (await freePort());
    const profile = `/tmp/opencode/chrome-cdp-profile-milestone-${cdpPort}`;
    log(`Chrome CDP en ${cdpPort}`);
    chrome = spawn(
      CHROME,
      [
        '--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars',
        '--window-size=1280,720', '--enable-unsafe-swiftshader', '--use-angle=swiftshader',
        `--remote-debugging-port=${cdpPort}`, '--remote-allow-origins=*', `--user-data-dir=${profile}`, 'about:blank',
      ],
      { stdio: 'ignore' },
    );

    let version = null;
    for (let i = 0; i < 60 && !version; i++) {
      try { version = await fetchJson(`http://127.0.0.1:${cdpPort}/json/version`); } catch { await wait(500); }
    }
    if (!version) throw new Error('Chrome no abrió el puerto de depuración');
    const tab = await fetchJson(`http://127.0.0.1:${cdpPort}/json/new?about:blank`, { method: 'PUT' });
    cdp = await connect(tab.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    // Pulsación de tecla REAL, despachada por CDP. El arnés original entraba al 4x4 con
    // `toggleVehicle()` directo, y por eso dejó pasar el bug que el usuario encontró
    // jugando: el flanco de F se levantaba pero nadie lo consumía. Un arnés que se
    // saltea la tecla no prueba el juego, prueba su propia API.
    const pressKey = async (code, key, vk) => {
      const base = { code, key, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base });
      await wait(140);
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
      await wait(140);
    };
    /**
     * Suelta la entrada inyectada ANTES de teclear: si hay entrada inyectada activa el
     * envoltorio le da prioridad y el flanco del teclado se descartaría. Es la misma
     * regla que vive en `src/main.ts`.
     */
    const pressF = async () => {
      await cdp.evaluate('window.__game.player.inject(null)');
      await pressKey('KeyF', 'f', 70);
    };
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });

    if (BLOCK_VEGETATION) {
      log('modo fallo de red: bloquea *vegetation/vegetation.json*');
      await cdp.send('Network.enable');
      await cdp.send('Network.setBlockedURLs', { urls: ['*vegetation/vegetation.json*'] });
    }

    // El primer arranque puede abortar una carga por la red del entorno (pasa
    // también en el baseline). Si el cuerpo muestra ese ERROR, se reintenta una vez.
    const probeApi = '!!(window.__game && window.__game.route && window.__game.player && window.__game.mission && window.__game.vehicle)';
    const waitApi = async () => {
      for (let i = 0; i < 120; i++) {
        await wait(1000);
        try {
          if (await cdp.evaluate(probeApi)) return true;
        } catch {
          // la página aún no responde: se sigue esperando
        }
      }
      return false;
    };
    log(`navegando a ${BASE}/ (personaje + misión)`);
    let ready = false;
    for (let attempt = 0; attempt < 2 && !ready; attempt++) {
      const errorsBefore = cdp.errors.length;
      await cdp.send('Page.navigate', { url: `${BASE}/` });
      ready = await waitApi();
      if (!ready && attempt === 0) {
        const aborted = await cdp.evaluate("document.body.innerText.includes('ERROR\\nFailed to fetch')").catch(() => false);
        if (!aborted) break;
        // El intento abortado no es la app que se mide: sus errores se descartan.
        cdp.errors.length = errorsBefore;
        log('carga abortada en el primer arranque; se reintenta una vez');
      }
    }
    if (!ready) {
      const partial = await cdp.evaluate('Object.keys(window.__game || {})').catch(() => null);
      throw new Error(`Falta la API de depuración en window.__game. Presente: ${JSON.stringify(partial)}. Se necesita route, player, mission y vehicle.`);
    }
    await wait(2000);

    const route = await cdp.evaluate('window.__game.route');
    check('api.route expone first-route', route && route.polyline && route.polyline.length > 100, { waypoints: route?.waypoints?.length, polyline: route?.polyline?.length }, 'polyline > 100 puntos');
    check('api.route.checkpoints incluye track-entry', Array.isArray(route?.checkpoints) && route.checkpoints.some((c) => c.id === 'track-entry'), route?.checkpoints?.map((c) => c.id), "incluye 'track-entry'");

    // El pueblo (FASE E): que cargue Y que siga BATCHEADO. Si alguien vuelve al patrón
    // "una malla por casa", 330 casas pasarían de 7 mallas a 330 y esto lo grita.
    const village = await cdp.evaluate('window.__game.village ? window.__game.village.stats() : null');
    report.pueblo = village;
    check('pueblo cargado y batcheado (meshes <= 20 con > 300 casas)', !!village && village.buildings > 300 && village.meshes <= 20, village, 'buildings > 300 y meshes <= 20');

    // La vegetación (FASE D): que cargue Y que siga BATCHEADA. Si alguien vuelve al
    // patrón "una malla por instancia", 30.000 instancias pasarían de 18 mallas a
    // miles y esto lo grita. TDD: este check corre en RED hasta que main.ts exponga
    // window.__game.vegetation con stats() (mismo envoltorio que village).
    const vegetation = await cdp.evaluate('window.__game.vegetation ? window.__game.vegetation.stats() : null');
    report.vegetacion = vegetation;
    if (BLOCK_VEGETATION) {
      check('vegetacion bloqueada no tumba el juego (vegetation === null)', vegetation === null, vegetation, '=== null');
      const core = await cdp.evaluate('!!(window.__game && window.__game.route && window.__game.player && window.__game.mission && window.__game.vehicle)');
      check('nucleo jugable disponible sin decoracion (route/player/mission/vehicle)', core === true, core, 'true');
    } else {
      // 21 = 7 tipos (4 árboles + 2 arbustos + 1 hierba) × 3 bandas LOD (near/mid/far).
      // El tope era 18 desde 6cef162 y quedó obsoleto al sumarse tipos de árbol en
      // 1a9f0bc (pasos visuales), no por el agua. 21 es el diseño actual (gate T7).
      check('vegetacion cargada y batcheada (meshes <= 21 con arboles/arbustos/hierba > 0)', !!vegetation && vegetation.trees > 0 && vegetation.shrubs > 0 && vegetation.grassTufts > 0 && vegetation.meshes <= 21, vegetation, 'trees/shrubs/grassTufts > 0 y meshes <= 21');
      // El corredor runtime debe coincidir con el builder (ROAD 12 m / TRACK 8 m):
      // cualquier exclusión acá significa que el runtime ensanchó el corredor y
      // removió instancias aprobadas por la fuente.
      check('vegetacion sin exclusiones por corredor (excludedByCorridor === 0)', vegetation?.excludedByCorridor === 0, vegetation?.excludedByCorridor, '=== 0');
    }

    // Instala el harness dentro de la página.
    await cdp.evaluate(HARNESS_SOURCE);
    const tracks = await cdp.evaluate('window.__harness.tracks');
    log(`polilínea: ${tracks.forwardM.toFixed(0)} m ida / ${tracks.backwardM.toFixed(0)} m vuelta`);

    const perfBefore = await cdp.evaluate('window.__game.perf()');
    report.perf_antes = perfBefore;
    report.datum = await cdp.evaluate('window.__game.auditDatum()');

    // ===================== FASE B: aparición =====================
    const spawnInfo = await cdp.evaluate(`(function () {
      var g = window.__game, v = g.vehicle.telemetry();
      return { x: v.x, z: v.z, y: v.y, groundY: g.terrainHeightAt(v.x, v.z), residual: v.wheelResidualMaxM,
               speed: v.speed, mode: g.player.mode(), startX: g.route.start.x, startZ: g.route.start.z,
               distToStart: Math.hypot(v.x - g.route.start.x, v.z - g.route.start.z), mission: g.mission.snapshot() };
    })()`);
    report.spawn = spawnInfo;
    check('FASE B: 4x4 sobre el terreno (|y - heightAt| <= 0.5 m)', Math.abs(spawnInfo.y - spawnInfo.groundY) <= 0.5, +Math.abs(spawnInfo.y - spawnInfo.groundY).toFixed(4), '<= 0.5');
    check('FASE B: spawn sobre route.start (<= 1 m)', spawnInfo.distToStart <= 1, +spawnInfo.distToStart.toFixed(3), '<= 1');
    check('FASE B: arranca a pie y detenido', spawnInfo.mode === 'on-foot' && Math.abs(spawnInfo.speed) < 0.01, { mode: spawnInfo.mode, speed: +spawnInfo.speed.toFixed(3) }, "mode='on-foot' y |v|<0.01");
    check('FASE B: misión en NOT_STARTED', spawnInfo.mission.state === 'NOT_STARTED', spawnInfo.mission.state, 'NOT_STARTED');
    await wait(1200);
    await cdp.screenshot(resolve(OUT_DIR, '01_spawn_villafranca.png'));
    report.capturas.push('01_spawn_villafranca.png');

    // ===================== Entrar al 4x4 =====================
    // Se entra con la TECLA F de verdad: es el gesto del jugador, y es el que estaba roto.
    await pressF();
    const enter = await cdp.evaluate(`(function () { var g = window.__game; g.player.step(0.2, 1/60); return { mode: g.player.mode(), mission: g.mission.snapshot().state }; })()`);
    report.pulsacion_f = { tecla: 'KeyF', via: 'Input.dispatchKeyEvent', mode: enter.mode, mission: enter.mission };
    check('entra al 4x4 con la TECLA F -> driving', enter.mode === 'driving', enter, "mode='driving'");
    check('misión pasa a ACTIVE al conducir', enter.mission === 'ACTIVE', enter.mission, 'ACTIVE');

    // ===================== FASE C: conducir al objetivo =====================
    const tgt = route.target;
    let outSim = 0;
    const remaining = () => Math.max(0.5, BUDGET_S - outSim);
    let stuckSegment = null;

    const seg = async (label, opts, shotName) => {
      const o = { ...opts, maxSim: Math.min(opts.maxSim ?? remaining(), remaining()) };
      const r = await cdp.evaluate(`window.__harness.drive(${JSON.stringify(o)})`);
      outSim += r.simSeconds;
      report.metricas = report.metricas || {};
      report.metricas[label] = r;
      if (r.reason === 'stuck') stuckSegment = { label, r };
      if (shotName) {
        await wait(1400);
        await cdp.screenshot(resolve(OUT_DIR, shotName));
        report.capturas.push(shotName);
      }
      log(`tramo ${label}: ${r.reason} en ${r.simSeconds.toFixed(1)} s sim · s=${r.projS.toFixed(0)}/${r.trackTotal.toFixed(0)} · estado=${r.missionState} · d_obj=${r.distanceToTargetM.toFixed(0)} m`);
      return r;
    };

    const outboundSegs = [];
    const segTracked = async (label, opts, shotName) => { const r = await seg(label, opts, shotName); outboundSegs.push({ label, r }); return r; };
    await segTracked('road', { stopS: 320, vTarget: 15 }, '02_road.png');
    await segTracked('track_entry', { stopS: 666, vTarget: 15 }, '03_track_entry.png');
    await segTracked('offroad', { stopS: 1510, vTarget: 13 }, '04_offroad.png');
    const rTarget = await segTracked('target', { stopS: tracks.forwardM + 5, stopPoint: tgt, stopRadius: 8, vTarget: 10 }, '05_target.png');

    check('FASE C: llega al objetivo dentro del presupuesto', rTarget.missionState === 'TARGET_REACHED' || rTarget.missionState === 'COMPLETED', { state: rTarget.missionState, distancia_restante_m: +rTarget.distanceToTargetM.toFixed(1), ultima_pose: rTarget.final, tiempo_sim_s: +outSim.toFixed(1) }, `TARGET_REACHED en <= ${BUDGET_S} s`);
    check('FASE C: sin atasco silencioso', stuckSegment === null, stuckSegment ? stuckSegment : null, '|v| < 0.5 m/s por > 5 s');
    {
      const maxLat = Math.max(...outboundSegs.map((s) => s.r.stats.maxLateralM));
      const maxSpd = Math.max(...outboundSegs.map((s) => s.r.stats.maxSpeed));
      check('FASE C: conduce sobre la polilínea (desvío lateral máx)', maxLat <= 15, +maxLat.toFixed(2), '<= 15 m');
      check('FASE C: velocidad bajo control', maxSpd <= 20, +maxSpd.toFixed(2), '<= 20 m/s');
    }

    // ===== Prohibido reparar desde el coche =====
    const fromCar = await cdp.evaluate(`window.__harness.repairFromCar(3)`);
    report.reparar_desde_coche = fromCar;
    check('FASE G: reparar DESDE EL COCHE no funciona', fromCar.endState === 'TARGET_REACHED' && fromCar.endProgress === 0, { state: fromCar.endState, progress: fromCar.endProgress }, "sigue TARGET_REACHED y progreso 0");

    // ===================== FASE F: a pie =====================
    // Bajar del 4x4 también con la TECLA F, no con la API.
    await pressF();
    const exitCar = await cdp.evaluate(`(function () { var g = window.__game; g.player.step(0.2, 1/60); return { mode: g.player.mode(), distObj: g.mission.snapshot().distanceToTargetM, canEnter: g.player.telemetry().canEnter }; })()`);
    check('FASE F: baja del 4x4 -> on-foot', exitCar.mode === 'on-foot', exitCar, "mode='on-foot'");

    const walked = await cdp.evaluate(`window.__harness.walk({ x: ${tgt.x}, z: ${tgt.z}, stopDist: 3.5, maxSim: 60, run: true })`);
    report.caminata = walked;
    check('FASE F: caminando entra en el radio del objetivo', walked.mission.distanceToTargetM <= ASSUMED_REACH_RADIUS_M, +walked.mission.distanceToTargetM.toFixed(2), `<= ${ASSUMED_REACH_RADIUS_M}`);
    await wait(1200);
    await cdp.screenshot(resolve(OUT_DIR, '06_interaction.png'));
    report.capturas.push('06_interaction.png');

    const repaired = await cdp.evaluate(`window.__harness.holdInteract(6)`);
    report.reparacion = repaired;
    check('FASE G: mantener E repara (progreso 1 y REPAIRED)', repaired.mission.state === 'REPAIRED' && repaired.mission.repairProgress === 1, { state: repaired.mission.state, progress: repaired.mission.repairProgress, sim_s: +repaired.simSeconds.toFixed(2) }, "REPAIRED con progreso 1");

    // ===================== FASE H: regreso =====================
    // Reparado, el jugador quedó junto al objetivo; el 4x4 puede estar a unos
    // metros. Se camina de vuelta al vehículo, que es lo que haría una persona.
    const walkBack = await cdp.evaluate(`(function () {
      var g = window.__game; var v = g.vehicle.telemetry();
      return window.__harness.walk({ x: v.x, z: v.z, stopDist: 0.5, stopOnCanEnter: true, maxSim: 90, run: true });
    })()`);
    report.caminata_al_4x4 = walkBack;
    check('FASE H: vuelve a quedar a tiro del 4x4', walkBack.telemetry.canEnter, { canEnter: walkBack.telemetry.canEnter, distanceToVehicleM: +walkBack.telemetry.distanceToVehicleM.toFixed(2), reason: walkBack.reason }, 'canEnter = true');

    // Volver a subir con la TECLA F: cierra el ciclo completo del jugador.
    await pressF();
    const reenter = await cdp.evaluate(`(function () { var g = window.__game; g.player.step(0.2, 1/60); return { mode: g.player.mode(), mission: g.mission.snapshot().state, canEnter: g.player.telemetry().canEnter }; })()`);
    check('FASE H: vuelve a subir -> driving y RETURNING', reenter.mode === 'driving' && reenter.mission === 'RETURNING', reenter, "driving + RETURNING");

    let retSim = 0;
    const retRemaining = () => Math.max(0.5, BUDGET_S - retSim);
    const rReturn = await cdp.evaluate(`window.__harness.drive(${JSON.stringify({ reverse: true, stopPoint: route.returnPoint, stopRadius: 22, stopStates: ['COMPLETED'], vTarget: 14, maxSim: retRemaining() })})`);
    retSim += rReturn.simSeconds;
    report.metricas = report.metricas || {};
    report.metricas.return = rReturn;
    log(`tramo regreso: ${rReturn.reason} en ${rReturn.simSeconds.toFixed(1)} s sim · s=${rReturn.projS.toFixed(0)}/${rReturn.trackTotal.toFixed(0)} · estado=${rReturn.missionState} · d_vuelta=${rReturn.distanceToReturnM.toFixed(0)} m`);
    await wait(1400);
    await cdp.screenshot(resolve(OUT_DIR, '07_return.png'));
    report.capturas.push('07_return.png');

    check('FASE H: regresa y COMPLETA dentro del presupuesto', rReturn.missionState === 'COMPLETED', { state: rReturn.missionState, distancia_restante_m: +rReturn.distanceToReturnM.toFixed(1), ultima_pose: rReturn.final, tiempo_sim_s: +retSim.toFixed(1) }, `COMPLETED en <= ${BUDGET_S} s`);
    check('FASE H: regreso sobre la polilínea (desvío lateral máx)', rReturn.stats.maxLateralM <= 15, +rReturn.stats.maxLateralM.toFixed(2), '<= 15 m');
    check('FASE H: regreso bajo control (velocidad máx)', rReturn.stats.maxSpeed <= 20, +rReturn.stats.maxSpeed.toFixed(2), '<= 20 m/s');
    check('FASE H: regreso sin derrape masivo', rReturn.stats.skiddingFraction <= 0.5, +rReturn.stats.skiddingFraction.toFixed(3), '<= 0.5');

    // ===================== Simetría acelerar/frenar + perf final =====================
    report.simetria = await cdp.evaluate(`window.__harness.measureSymmetry(${route.start.x}, ${route.start.z})`);
    report.perf_despues = await cdp.evaluate('window.__game.perf()');
    report.mision_final = await cdp.evaluate('window.__game.mission.snapshot()');

    // Sonda informativa (NO bloquea y corre al final para no perturbar el recorrido):
    // ¿el flanco de F inyectado entra/sale del 4x4? Documenta el estado de la
    // integración main.ts <-> controles, que cambió durante el desarrollo.
    const toggleProbe = await cdp.evaluate(`(function () {
      var g = window.__game; var before = g.player.mode();
      g.player.inject({ toggle: true }); g.player.step(0.1, 1 / 60);
      var after = g.player.mode();
      g.player.inject({ toggle: true }); g.player.step(0.1, 1 / 60);
      var restored = g.player.mode(); g.player.inject(null);
      return { before: before, after: after, restored: restored };
    })()`);
    report.inject_toggle = {
      ...toggleProbe,
      funciona: toggleProbe.after !== toggleProbe.before && toggleProbe.restored === toggleProbe.before,
      nota:
        'Sonda de regresión del bug de integración: el flanco de F inyectado se levantaba pero ' +
        'nadie lo consumía, así que la tecla F no hacía NADA. Si funciona=true, main.ts consume ' +
        'el flanco en el loop de simulación. El arnés además entra/sale con KeyF real por CDP.',
    };
    log(`sonda inject({toggle:true}): ${toggleProbe.before} -> ${toggleProbe.after} -> ${toggleProbe.restored} (funciona=${report.inject_toggle.funciona})`);

    report.errores_consola = cdp.errors;
    check('sin excepciones ni console.error', cdp.errors.length === 0, cdp.errors.length, '0', cdp.errors.slice(0, 5));

    const missingShots = ['01_spawn_villafranca.png', '02_road.png', '03_track_entry.png', '04_offroad.png', '05_target.png', '06_interaction.png', '07_return.png'].filter(
      (f) => !existsSync(resolve(OUT_DIR, f)),
    );
    check('7 capturas escritas', missingShots.length === 0, missingShots, 'sin faltantes');

    exitCode = checks.every((c) => c.ok) ? 0 : 1;
  } catch (error) {
    report.error_fatal = error instanceof Error ? error.message : String(error);
    // Los errores capturados se vuelcan TAMBIÉN acá. Sin esto, un fallo temprano (el
    // bootstrap explota antes de publicar `window.__game`) se reportaba con
    // `errores_consola: []` y el arnés no podía decir QUÉ explotó: no diagnosticaba.
    report.errores_consola = cdp?.errors ?? [];
    console.error(`${LOG_PREFIX} ERROR FATAL: ${report.error_fatal}`);
    for (const e of report.errores_consola) console.error(`${LOG_PREFIX}   ${e}`);
  } finally {
    try { writeFileSync(resolve(OUT_DIR, 'drive_report.json'), JSON.stringify(report, null, 2) + '\n'); } catch {}
    if (chrome) chrome.kill('SIGKILL');
    if (serverChild) { try { process.kill(-serverChild.pid, 'SIGKILL'); } catch { try { serverChild.kill('SIGKILL'); } catch {} } }
  }

  // Resumen legible.
  console.log('\n================ CHECKLIST MILESTONE 1 ================');
  for (const c of report.checks) console.log(`${c.ok ? '[x]' : '[ ]'} ${c.name}`);
  if (report.checks.some((c) => !c.ok)) {
    console.log('\n--- FALLOS ---');
    for (const c of report.checks.filter((c) => !c.ok)) console.log(`- ${c.name}: valor=${JSON.stringify(c.value)} umbral=${JSON.stringify(c.threshold)}${c.detail ? ' detalle=' + JSON.stringify(c.detail) : ''}`);
  }
  const fps = report.perf_despues ? report.perf_despues.fps.toFixed(1) : 'n/a';
  console.log(`\nFPS headless ${fps} (NO es señal de rendimiento: SwiftShader CPU). Draw calls/triángulos sí valen.`);
  console.log(`Reporte: ${resolve(OUT_DIR, 'drive_report.json')}`);
  console.log(`RESULTADO: ${exitCode === 0 ? 'OK' : 'FALLO'}`);
  return exitCode;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
