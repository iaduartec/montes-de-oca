// Arnés de los PRESETS del vehículo (FASE 1).
// Chrome headless + CDP con el WebSocket nativo de Node (cero deps nuevas),
// mismo andamiaje que scripts/water/drive_water.mjs.
//
// Prueba contra la APP REAL (camino `?player=0` + `setInput`, el más limpio
// para rectas: sin personaje ni misión en el medio):
//   (a) `params()` refleja la masa/drag del preset aplicado con `setPreset`;
//   (b) ordenación de prestaciones con margen (>10%): VELOCIDAD TOPE
//       `carga < estandar < patrulla` como métrica PRIMARIA y tiempo 0→15 m/s
//       como secundaria. La velocidad tope es la métrica estable porque converge
//       a una asíntota fijada por `maxSpeed` (22/32/38: brechas de 30–70%),
//       mientras que el 0→15 depende del transitorio inicial (fricción estática
//       y patinada: patrulla y estándar aceleran parecido porque a la patrulla
//       la limita la tracción μ·N, no el motor);
//   (c) `setPreset('estandar')` restaura EXACTAMENTE `DEFAULT_VEHICLE_PARAMS`;
//   (d) un id desconocido devuelve false, no cambia nada y cae al default;
//   (e) persistencia: recargar con localStorage `selectedVehicleId` aplica el
//       preset; `?vehicle=` gana sobre localStorage;
//   (f) consola sin errores. Mediciones en output/vehicle_presets.json.
//
// La recta se deriva del dato: se barre una grilla alrededor de `route.start`
// con `terrainHeightAt` y se elige el punto de menor pendiente, apuntando
// perpendicular al gradiente (misma fórmula que `measureSymmetry` en
// drive_milestone.mjs). Los tres presets corren sobre la MISMA pista y guiñada,
// así que el orden relativo no depende del punto elegido.
//
// Uso: node scripts/vehicle/drive_presets.mjs [--base http://127.0.0.1:5173]
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');

const argv = process.argv.slice(2);
function arg(name, fallback) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
}
const PORT = Number(arg('--port', '9229'));
const BASE = arg('--base', 'http://127.0.0.1:5173');
const OUT_DIR = resolve(root, arg('--out-dir', 'output'));
const CHROME = arg('--chrome', 'google-chrome');
const PROFILE = '/tmp/opencode/chrome-cdp-profile-vehicle-presets';

// Esperado por preset (mismo que src/vehicle/presets.ts; la pertenencia a
// VehicleParams y los rangos los verifica validate_presets.mjs).
const ESPERADO = {
  estandar: { mass: 1800, dragCoefficient: 0.66 },
  patrulla: { mass: 1200, dragCoefficient: 0.45 },
  carga: { mass: 2400, dragCoefficient: 0.95 },
};

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
}

async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, reject) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  return new Cdp(ws);
}

async function waitReady(cdp, probe) {
  let ready = false;
  for (let i = 0; i < 150 && !ready; i++) {
    await wait(1000);
    try {
      ready = await cdp.evaluate(probe);
    } catch {
      ready = false;
    }
  }
  if (!ready) throw new Error(`la app no quedó lista (${probe})`);
}

// ---------------------------------------------------------------------------
// Código que corre DENTRO de la página. Sin template literals adentro: el
// bloque viaja como string desde Node y `${}` chocaría con la interpolación.
// ---------------------------------------------------------------------------
const HARNESS_SOURCE = `
window.__harnessPresets = (function () {
  var g = window.__game;
  var DT = 1 / 60;
  var pistaCache = null;

  function pendiente(x, z) {
    var E = 5;
    var gx = (g.terrainHeightAt(x + E, z) - g.terrainHeightAt(x - E, z)) / (2 * E);
    var gz = (g.terrainHeightAt(x, z + E) - g.terrainHeightAt(x, z - E)) / (2 * E);
    return Math.hypot(gx, gz);
  }

  // Punto más plano alrededor del inicio de la ruta + rumbo perpendicular al
  // gradiente (misma fórmula que measureSymmetry en drive_milestone.mjs).
  function pista() {
    if (pistaCache) return pistaCache;
    var sx = g.route.start.x, sz = g.route.start.z;
    var mejor = { x: sx, z: sz, s: pendiente(sx, sz) };
    for (var dx = -100; dx <= 100; dx += 20) {
      for (var dz = -100; dz <= 100; dz += 20) {
        var s = pendiente(sx + dx, sz + dz);
        if (s < mejor.s) mejor = { x: sx + dx, z: sz + dz, s: s };
      }
    }
    var n = g.terrainNormalAt(mejor.x, mejor.z);
    var ny = Math.max(n.y, 1e-6);
    var yaw = Math.atan2(n.z / ny, -n.x / ny);
    pistaCache = { x: mejor.x, z: mejor.z, yaw: yaw, slopeTan: mejor.s };
    return pistaCache;
  }

  // Gas a fondo sobre la pista; mide velocidad tope y 0->15 m/s.
  function recta(id, seconds) {
    var aplicado = g.vehicle.setPreset(id);
    var p = pista();
    g.vehicle.teleport(p.x, p.z, p.yaw);
    g.vehicle.setState({ speed: 0, lateral: 0 });
    var antes = g.vehicle.params();
    g.vehicle.setInput({ throttle: 1, steer: 0, handbrake: false, neutral: false });
    var t = 0, vmax = 0, t15 = null, muestras = [];
    var pasos = Math.round(seconds / DT);
    for (var i = 0; i < pasos; i++) {
      g.vehicle.step(DT, DT);
      t += DT;
      var v = Math.abs(g.vehicle.telemetry().speed);
      if (v > vmax) vmax = v;
      if (t15 === null && v >= 15) t15 = t;
      if (i % 60 === 0) muestras.push({ t: +t.toFixed(1), v: +v.toFixed(2) });
    }
    g.vehicle.setInput(null);
    var fin = g.vehicle.telemetry();
    return {
      id: id, aplicado: aplicado, pista: p,
      params: { mass: antes.mass, dragCoefficient: antes.dragCoefficient },
      vmax: +vmax.toFixed(3), t15: t15 === null ? null : +t15.toFixed(3),
      fin: { x: +fin.x.toFixed(1), z: +fin.z.toFixed(1) },
      muestras: muestras
    };
  }

  return { pista: pista, recta: recta };
})();
'ok';
`;

// DEFAULT_VEHICLE_PARAMS reales desde el fuente (misma regex que el validador).
function leerDefaults() {
  const src = readFileSync(resolve(root, 'src/vehicle/physics.ts'), 'utf8');
  const block = src.match(/DEFAULT_VEHICLE_PARAMS\s*:\s*VehicleParams\s*=\s*\{([\s\S]*?)\};/);
  if (!block) throw new Error('no se pudo extraer DEFAULT_VEHICLE_PARAMS');
  const defaults = {};
  for (const m of block[1].matchAll(/(\w+)\s*:\s*(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g)) {
    defaults[m[1]] = Number(m[2]);
  }
  return defaults;
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  rmSync(PROFILE, { recursive: true, force: true });
  const defaults = leerDefaults();

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

  const failures = [];
  const check = (nombre, ok, detalle) => {
    console.log(`[${ok ? 'PASS' : 'FAIL'}] ${nombre}: ${detalle}`);
    if (!ok) failures.push(`${nombre}: ${detalle}`);
  };
  const report = { generado_por: 'scripts/vehicle/drive_presets.mjs', base: BASE, fecha: new Date().toISOString() };

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

    console.log('[presets-drive] navegando a la app (?player=0, sin preset pedido)');
    await cdp.send('Page.navigate', { url: `${BASE}/?player=0` });
    await waitReady(cdp, '!!(window.__game && window.__game.vehicle && window.__game.route)');
    await wait(2500);
    await cdp.evaluate(HARNESS_SOURCE);

    // ---- Arranque por defecto: estandar === DEFAULT_VEHICLE_PARAMS. ----
    const arranque = await cdp.evaluate('({ preset: window.__game.vehicle.preset(), params: window.__game.vehicle.params() })');
    report.arranque = { preset: arranque.preset };
    check('arranque por defecto: preset estandar', arranque.preset === 'estandar', arranque.preset);
    check(
      'arranque por defecto: params === DEFAULT_VEHICLE_PARAMS',
      Object.keys(defaults).every((k) => arranque.params[k] === defaults[k]),
      'comparación exacta clave por clave',
    );

    // ---- (a)+(b): cada preset, params y recta de 25 s. ----
    const corridas = {};
    for (const id of ['estandar', 'patrulla', 'carga']) {
      const r = await cdp.evaluate(`window.__harnessPresets.recta('${id}', 25)`);
      corridas[id] = r;
      console.log(`[presets-drive] ${id}: vmax=${r.vmax} m/s t15=${r.t15} s pista=(${r.pista.x.toFixed(0)}, ${r.pista.z.toFixed(0)}) pend=${r.pista.slopeTan.toFixed(3)}`);
    }
    report.corridas = corridas;

    for (const id of Object.keys(ESPERADO)) {
      const r = corridas[id];
      check(`(a) ${id}: params() refleja masa/drag`, r.params.mass === ESPERADO[id].mass && r.params.dragCoefficient === ESPERADO[id].dragCoefficient, `mass=${r.params.mass} drag=${r.params.dragCoefficient}`);
    }

    const vCarga = corridas.carga.vmax;
    const vEstandar = corridas.estandar.vmax;
    const vPatrulla = corridas.patrulla.vmax;
    const margenCarga = (vEstandar - vCarga) / vEstandar;
    const margenPatrulla = (vPatrulla - vEstandar) / vEstandar;
    check('(b) velocidad tope: carga < estandar < patrulla', vCarga < vEstandar && vEstandar < vPatrulla, `carga=${vCarga} estandar=${vEstandar} patrulla=${vPatrulla} m/s`);
    check('(b) margen carga vs estandar >10%', margenCarga > 0.1, `${(margenCarga * 100).toFixed(1)}%`);
    check('(b) margen patrulla vs estandar >10%', margenPatrulla > 0.1, `${(margenPatrulla * 100).toFixed(1)}%`);

    // Secundaria (informativa): 0→15 m/s. La patrulla patina al inicio (la
    // limita μ·N, no el motor), así que sólo se exige que carga sea la más lenta.
    const tCarga = corridas.carga.t15;
    const tEstandar = corridas.estandar.t15;
    const tPatrulla = corridas.patrulla.t15;
    report.t15 = { carga: tCarga, estandar: tEstandar, patrulla: tPatrulla };
    const tOk = tCarga !== null && tEstandar !== null && tCarga > tEstandar * 1.1;
    check('(b-sec) 0→15 m/s: carga la más lenta con margen', tOk, `carga=${tCarga}s estandar=${tEstandar}s patrulla=${tPatrulla}s`);

    // ---- (c): volver a estandar restaura EXACTAMENTE los defaults. ----
    await cdp.evaluate("window.__game.vehicle.setPreset('patrulla')");
    const restaurado = await cdp.evaluate("window.__game.vehicle.setPreset('estandar'); ({ preset: window.__game.vehicle.preset(), params: window.__game.vehicle.params() })");
    report.restaurado_preset = restaurado.preset;
    check("(c) setPreset('estandar') devuelve preset estandar", restaurado.preset === 'estandar', restaurado.preset);
    check(
      "(c) setPreset('estandar') restaura EXACTAMENTE los defaults",
      Object.keys(defaults).every((k) => restaurado.params[k] === defaults[k]),
      'comparación exacta clave por clave tras patrulla→estandar',
    );

    // ---- (d): id desconocido no rompe nada. ----
    const raro = await cdp.evaluate(
      "(() => { const antes = window.__game.vehicle.params(); const ok = window.__game.vehicle.setPreset('inexistente'); return { ok, preset: window.__game.vehicle.preset(), despues: window.__game.vehicle.params() }; })()",
    );
    report.id_desconocido = { setPreset: raro.ok, preset: raro.preset };
    check('(d) setPreset desconocido devuelve false', raro.ok === false, JSON.stringify(raro.ok));
    check('(d) preset y params intactos tras id desconocido', raro.preset === 'estandar' && Object.keys(defaults).every((k) => raro.despues[k] === defaults[k]), `preset=${raro.preset}`);

    // ---- ?vehicle=id en la URL (con localStorage limpio). ----
    await cdp.evaluate('window.localStorage.clear()');
    await cdp.send('Page.navigate', { url: `${BASE}/?player=0&vehicle=patrulla` });
    await waitReady(cdp, '!!(window.__game && window.__game.vehicle && window.__game.vehicle.preset() === "patrulla")');
    await wait(1500);
    const porUrl = await cdp.evaluate('({ preset: window.__game.vehicle.preset(), mass: window.__game.vehicle.params().mass })');
    report.por_url = porUrl;
    check('?vehicle=patrulla aplica el preset al arrancar', porUrl.preset === 'patrulla' && porUrl.mass === 1200, JSON.stringify(porUrl));

    await cdp.send('Page.navigate', { url: `${BASE}/?player=0&vehicle=bogus` });
    await waitReady(cdp, '!!(window.__game && window.__game.vehicle)');
    await wait(1500);
    const urlRara = await cdp.evaluate('window.__game.vehicle.preset()');
    check('?vehicle desconocido cae al default', urlRara === 'estandar', urlRara);
    report.url_desconocida = urlRara;

    // ---- (e): persistencia por localStorage; la URL gana. ----
    await cdp.evaluate("window.localStorage.setItem('selectedVehicleId', 'carga')");
    await cdp.send('Page.navigate', { url: `${BASE}/?player=0` });
    await waitReady(cdp, '!!(window.__game && window.__game.vehicle && window.__game.vehicle.preset() === "carga")');
    await wait(1500);
    const persistido = await cdp.evaluate('({ preset: window.__game.vehicle.preset(), mass: window.__game.vehicle.params().mass })');
    report.persistencia = persistido;
    check('recarga con localStorage=carga aplica el preset', persistido.preset === 'carga' && persistido.mass === 2400, JSON.stringify(persistido));

    await cdp.send('Page.navigate', { url: `${BASE}/?player=0&vehicle=patrulla` });
    await waitReady(cdp, '!!(window.__game && window.__game.vehicle && window.__game.vehicle.preset() === "patrulla")');
    await wait(1500);
    const ganaUrl = await cdp.evaluate('window.__game.vehicle.preset()');
    check('?vehicle gana sobre localStorage', ganaUrl === 'patrulla', `url=patrulla storage=carga -> ${ganaUrl}`);

    // ---- (f): consola sin errores. ----
    report.errores_consola = cdp.errors;
    check('(f) consola sin errores', cdp.errors.length === 0, `${cdp.errors.length} errores`);
    for (const e of cdp.errors) console.error(`[presets-drive]   ${e}`);

    writeFileSync(resolve(OUT_DIR, 'vehicle_presets.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(`\n=> mediciones en ${OUT_DIR}/vehicle_presets.json`);

    if (failures.length > 0) {
      console.error(`\nFALLA: ${failures.length} checks`);
      for (const f of failures) console.error(`  - ${f}`);
      process.exitCode = 1;
    }
  } finally {
    chrome.kill('SIGKILL');
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
