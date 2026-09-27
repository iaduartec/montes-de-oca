// Arnés E2E del CATÁLOGO de vehículos (Tarea 9).
// Chrome headless + CDP con el WebSocket nativo de Node (cero deps nuevas),
// mismo andamiaje que scripts/vehicle/drive_selector.mjs.
//
// Verifica contra la APP REAL, en modo misión (a pie, como arranca el juego):
//   A. arranque: actor `estandar`, categoría todoterreno;
//   B. los 8 ids del catálogo se conducen (velocidad > 0 tras dar gas);
//   C. las dos motos se inclinan, caen y se recuperan;
//   D. cambio rechazado con el vehículo en movimiento y sin apoyo (no toca
//      tarjeta, preset ni storage);
//   E. diez cambios entre categorías dejan los recursos gráficos en la línea base;
//   F. entrar y salir funciona con un 4x4 y con una moto;
//   G. consola sin errores. Reporte en output/vehicle_catalog.json y hasta tres
//      capturas (una por categoría) en output/vehicle_catalog/.
//
// Uso: node scripts/vehicle/drive_catalog.mjs [--base http://127.0.0.1:5173]
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
const PORT = Number(arg('--port', '9235'));
const BASE = arg('--base', 'http://127.0.0.1:5173');
const OUT_DIR = resolve(root, arg('--out-dir', 'output/vehicle_catalog'));
const CHROME = arg('--chrome', 'google-chrome');
const PROFILE = '/tmp/opencode/chrome-cdp-profile-vehicle-catalog';
const DT = 1 / 60;
const IDS = ['estandar', 'patrulla', 'carga', 'explorador', 'turismo', 'rally', 'trail', 'enduro'];
const MOTOS = ['trail', 'enduro'];

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchOk(url) {
  try {
    const res = await fetch(url);
    return res.ok;
  } catch {
    return false;
  }
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
  async screenshot(path) {
    const result = await this.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(path, Buffer.from(result.data, 'base64'));
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
    let startupError = null;
    try {
      ready = await cdp.evaluate(probe);
      startupError = await cdp.evaluate(
        "document.body.innerText.startsWith('ERROR\\n') ? document.body.innerText.split('\\n').slice(0, 2).join(': ') : null",
      );
    } catch {
      ready = false;
    }
    if (startupError) throw new Error(startupError);
  }
  if (!ready) throw new Error(`la app no quedó lista (${probe})`);
}

async function navigateReady(cdp, url, probe) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const errorsBefore = cdp.errors.length;
    await cdp.send('Page.navigate', { url });
    try {
      await waitReady(cdp, probe);
      return;
    } catch (error) {
      const fetchAborted = await cdp.evaluate("document.body.innerText.includes('ERROR\\nFailed to fetch')").catch(() => false);
      if (!fetchAborted || attempt > 0) throw error;
      cdp.errors.length = errorsBefore;
      console.warn('[catalog] carga de datos abortada en el primer arranque; se reintenta una vez');
    }
  }
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

  const failures = [];
  const check = (nombre, ok, detalle) => {
    console.log(`[${ok ? 'PASS' : 'FAIL'}] ${nombre}: ${detalle}`);
    if (!ok) failures.push(`${nombre}: ${detalle}`);
  };
  const report = { generado_por: 'scripts/vehicle/drive_catalog.mjs', base: BASE, fecha: new Date().toISOString() };

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

    await navigateReady(cdp, `${BASE}/`, '!!(window.__game && window.__game.vehicle)');
    await wait(1500);

    // ---- A. arranque ----
    const arranque = await cdp.evaluate(
      '({ preset: window.__game.vehicle.preset(), category: window.__game.vehicle.category() })',
    );
    report.arranque = arranque;
    check('arranca en estandar (todoterreno)', arranque.preset === 'estandar' && arranque.category === 'todoterreno', JSON.stringify(arranque));

    // ---- B. los 8 ids se conducen ----
    const baseline = await cdp.evaluate('window.__game.perf()');
    report.baseline = baseline;
    const drivable = [];
    const perId = {};
    for (const id of IDS) {
      const result = await cdp.evaluate(`(function () {
        var g = window.__game, v = g.vehicle;
        v.setState({ speed: 0, lateral: 0 });
        var changed = v.setPreset('${id}');
        var category = v.category();
        v.setInput({ throttle: 1, steer: 0, handbrake: false, neutral: false });
        v.step(0.8, 1/60);
        var t = v.telemetry();
        v.setInput(null);
        v.setState({ speed: 0, lateral: 0 });
        return { changed: changed, category: category, speed: t.speed, x: t.x, z: t.z };
      })()`);
      perId[id] = { changed: result.changed, category: result.category, speed: +result.speed.toFixed(3) };
      if (result.changed && result.category && result.speed > 0.5) drivable.push(id);
    }
    report.por_id = perId;
    check('los 8 vehículos se conducen', drivable.length === 8, `${drivable.length}: ${drivable.join(', ')}`);

    // ---- C. motos: inclinación, caída y recuperación ----
    const motoReport = {};
    for (const id of MOTOS) {
      const r = await cdp.evaluate(`(function () {
        var g = window.__game, v = g.vehicle;
        v.setState({ speed: 0, lateral: 0 });
        v.setPreset('${id}');
        v.setInput({ throttle: 1, steer: 1, handbrake: false, neutral: false });
        v.step(2.0, 1/60);
        var fell = v.telemetry().fallen === true;
        var lean = v.telemetry().leanRad;
        v.setInput(null);
        var recovered = v.recover();
        var after = v.telemetry().fallen === true;
        v.setState({ speed: 0, lateral: 0 });
        return { category: v.category(), fell: fell, lean: lean, recovered: recovered, stillFallen: after };
      })()`);
      motoReport[id] = r;
      check(`moto ${id}: cae y se recupera`, r.category === 'moto' && r.fell === true && r.recovered === true && r.stillFallen === false, JSON.stringify(r));
    }
    report.motos = motoReport;

    // ---- D. rechazos: en movimiento y sin apoyo ----
    await cdp.evaluate("window.__game.vehicle.setPreset('turismo')");
    const rechazoMov = await cdp.evaluate(`(function () {
      var g = window.__game, v = g.vehicle;
      v.setState({ speed: 3, lateral: 0 });
      var before = v.preset();
      var ok = v.setPreset('estandar');
      var after = v.preset();
      var storage = window.localStorage.getItem('selectedVehicleId');
      v.setState({ speed: 0, lateral: 0 });
      return { ok: ok, before: before, after: after, storage: storage };
    })()`);
    report.rechazo_movimiento = rechazoMov;
    check(
      'cambio en movimiento rechazado sin tocar preset ni storage',
      rechazoMov.ok === false && rechazoMov.before === 'turismo' && rechazoMov.after === 'turismo' && rechazoMov.storage === 'turismo',
      JSON.stringify(rechazoMov),
    );

    const rechazoApoyo = await cdp.evaluate(`(function () {
      var g = window.__game, v = g.vehicle, route = g.route;
      var before = v.preset();
      v.teleport(route.target.x, route.target.z, route.targetYaw);
      var ok = v.setPreset('estandar');
      var after = v.preset();
      v.teleport(route.start.x, route.start.z, route.startYaw);
      return { ok: ok, before: before, after: after };
    })()`);
    report.rechazo_apoyo = rechazoApoyo;
    check(
      'cambio sobre el claro del repetidor rechazado sin tocar preset',
      rechazoApoyo.ok === false && rechazoApoyo.after === rechazoApoyo.before,
      JSON.stringify(rechazoApoyo),
    );

    // ---- E. diez cambios entre categorías y recursos estables ----
    const sequence = ['estandar', 'turismo', 'trail', 'patrulla', 'rally', 'enduro', 'carga', 'explorador', 'trail', 'turismo', 'estandar'];
    const switches = [];
    for (const id of sequence) {
      const done = await cdp.evaluate(
        `(function () { var v = window.__game.vehicle; v.setState({ speed: 0, lateral: 0 }); return v.setPreset('${id}'); })()`,
      );
      switches.push({ id: id, ok: done });
    }
    report.cambios = switches;
    const todosOk = switches.every((s) => s.ok === true);
    check('once cambios entre categorías aceptados', todosOk, JSON.stringify(switches.filter((s) => !s.ok)));
    const after = await cdp.evaluate('window.__game.perf()');
    report.recursos = { baseline: baseline, after: after };
    const ratio = (a, b) => (b === 0 ? 1 : a / b);
    // `activeMeshes` depende del último render (puede ser 0 sin frame); la
    // propiedad del actor se mide con triángulos y vértices de la escena.
    const triOk = ratio(after.triangles, baseline.triangles) < 1.15 && ratio(after.triangles, baseline.triangles) > 0.85;
    const vertOk = ratio(after.vertices, baseline.vertices) < 1.15 && ratio(after.vertices, baseline.vertices) > 0.85;
    check('recursos gráficos estables tras once cambios', triOk && vertOk, `tri ${baseline.triangles}→${after.triangles} vert ${baseline.vertices}→${after.vertices}`);

    // ---- F. entrar y salir con 4x4 y con moto ----
    const entrar = async (id) => {
      const r = await cdp.evaluate(`(function () {
        var g = window.__game, v = g.vehicle, p = g.player;
        v.setState({ speed: 0, lateral: 0 });
        var changed = v.setPreset('${id}');
        p.inject({ toggle: true });
        p.step(0.2, 1/60);
        var inside = p.mode();
        p.inject({ toggle: true });
        p.step(0.2, 1/60);
        var outside = p.mode();
        p.inject(null);
        return { changed: changed, category: v.category(), inside: inside, outside: outside };
      })()`);
      return r;
    };
    const enterCar = await entrar('estandar');
    const enterMoto = await entrar('enduro');
    report.entrada = { estandar: enterCar, enduro: enterMoto };
    check(
      'entrar y salir con 4x4',
      enterCar.inside === 'driving' && enterCar.outside === 'on-foot',
      JSON.stringify(enterCar),
    );
    check(
      'entrar y salir con moto',
      enterMoto.inside === 'driving' && enterMoto.outside === 'on-foot',
      JSON.stringify(enterMoto),
    );

    // ---- G. capturas por categoría (hasta 3) ----
    const shots = [
      { id: 'explorador', file: '01_todoterreno.png' },
      { id: 'turismo', file: '02_coche.png' },
      { id: 'trail', file: '03_moto.png' },
    ];
    const shotPaths = [];
    for (const shot of shots) {
      await cdp.evaluate(`(function () {
        var g = window.__game, v = g.vehicle, p = g.player;
        v.setState({ speed: 0, lateral: 0 });
        v.setPreset('${shot.id}');
        v.setInput({ throttle: 1, steer: 0, handbrake: false, neutral: false });
        v.step(0.6, 1/60);
        v.setInput(null);
      })()`);
      await wait(400);
      const path = resolve(OUT_DIR, shot.file);
      await cdp.screenshot(path);
      shotPaths.push(path);
    }
    report.capturas = shotPaths;

    // ---- H. consola sin errores ----
    check('consola sin errores', cdp.errors.length === 0, cdp.errors.length === 0 ? '0 errores' : cdp.errors.join(' | '));
    report.errores_consola = cdp.errors;

    writeFileSync(resolve(root, 'output', 'vehicle_catalog.json'), `${JSON.stringify(report, null, 2)}\n`);
    console.log(`=> reporte en ${resolve(root, 'output', 'vehicle_catalog.json')}`);
  } finally {
    chrome.kill('SIGTERM');
  }

  if (failures.length > 0) {
    console.error(`\nFALLARON ${failures.length} checks:\n- ${failures.join('\n- ')}`);
    process.exit(1);
  }
  console.log('\nTODO OK');
}

main().catch((error) => {
  console.error(`FALLO: ${error.stack ?? error.message}`);
  process.exit(1);
});
