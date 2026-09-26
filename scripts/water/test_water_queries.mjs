// Arnés de la API de consulta del AGUA (AGUA T5).
// Chrome headless + CDP con el WebSocket nativo de Node (cero deps nuevas),
// mismo patrón que scripts/water/capture_water.mjs y
// scripts/roads/draping/capture_draping.mjs.
//
// Prueba contra la APP REAL (`window.__game.water` de src/environment/water.ts):
//   1. centro del vaso (2350,1300): depthAt > 6 (batimetría real 7,01 m);
//   2. seco lejos del agua (3000,3900): depthAt === 0;
//   3. orilla oeste del vaso (2050,1300): depthAt === 0 (89 m del anillo);
//   4. vado del Oca (3176,3450): 0 < depthAt <= 0,35; cruce seco (3139,3485)
//      === 0 — "2 mojados + 1 seco, todos ≤0,35" (ruling T3/T4);
//   5. regresión del fix de T4: (2619.67, 665.63) fuera del anillo con celda
//      del depthGrid a 0,125 m → depthAt === 0 (antes del fix devolvía agua);
//   6. fango DERIVADO del dato (ruling T5: el (2150,1230) del plan está a
//      66 m del anillo, fuera de la banda de 12 m): primer punto a ~5 m por
//      fuera del anillo con depthAt === 0 y pendiente <20° → isMuddy true;
//      (2150,1230) queda como control negativo (isMuddy false);
//   7. orilla segura: (a) desde el centro, INVARIANTE null o punto ≤150 m en
//      seco con pendiente <20° (null es legal: §5.3.4 → fallback de T6);
//      (b) desde un punto derivado a ~25 m por dentro de la orilla → no-null,
//      ≤150 m, en seco, pendiente <20°;
//   8. consola de la página sin errores.
//
// Uso: node scripts/water/test_water_queries.mjs [--base http://127.0.0.1:5173]
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
const BASE = arg('--base', 'http://127.0.0.1:5173');
const OUT_DIR = resolve(root, arg('--out-dir', 'output'));
const CHROME = arg('--chrome', 'google-chrome');
const PROFILE = '/tmp/opencode/chrome-cdp-profile-water-queries';

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

function qs(params) {
  return new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString();
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

    const report = {
      generado_por: 'scripts/water/test_water_queries.mjs',
      base: BASE,
      fecha: new Date().toISOString(),
      casos: {},
    };

    // Vista del vaso: la API no depende de la cámara, pero se fija una para
    // que la corrida sea reproducible y la consola cargue el mismo mundo.
    console.log('[agua-queries] navegando a la vista del vaso');
    await cdp.send('Page.navigate', {
      url: `${BASE}/?${qs({ px: 2350, py: 175, pz: 1300, tx: 2434, ty: 150, tz: 1523 })}`,
    });
    await waitReady(cdp, '!!(window.__game && window.__game.water)');
    await wait(2500);

    const depthAt = (x, z) => cdp.evaluate(`window.__game.water.depthAt(${x}, ${z})`);

    // ---- 1. Centro del vaso: profundo (> 6 m; el dato trae 7,01 m). ----
    const dCentro = await depthAt(2350, 1300);
    report.casos.centro_vaso = { x: 2350, z: 1300, depth: dCentro };
    check('centro del vaso profundo (> 6 m)', dCentro > 6, `${dCentro.toFixed(3)} m`);

    // ---- 2. Seco lejos del agua. ----
    const dSeco = await depthAt(3000, 3900);
    report.casos.seco_lejos = { x: 3000, z: 3900, depth: dSeco };
    check('seco lejos del agua (=== 0)', dSeco === 0, `${dSeco}`);

    // ---- 3. Orilla oeste del vaso: seco (a 89 m del anillo). ----
    const dOrilla = await depthAt(2050, 1300);
    report.casos.orilla_oeste = { x: 2050, z: 1300, depth: dOrilla };
    check('orilla oeste del vaso en seco (=== 0)', dOrilla === 0, `${dOrilla}`);

    // ---- 4. Vado del Oca: 2 mojados + 1 seco, todos ≤0,35 m. ----
    // (3176,3450) real 0,25; (3118,3501) real 0,18; (3139,3485) es un cruce
    // SECO por ruling (0,00): la cinta pasa bajo la pista y el DEM trae el
    // relleno por encima de la lámina (ver informe de T3).
    const vados = await cdp.evaluate(
      '(() => { const w = window.__game.water; return [[3176,3450],[3118,3501],[3139,3485]].map(([x,z]) => ({ x, z, depth: w.depthAt(x, z) })); })()',
    );
    report.casos.vados = vados;
    check('vado del Oca (3176,3450) vadeable (0 < d <= 0,35)', vados[0].depth > 0 && vados[0].depth <= 0.35, `${vados[0].depth.toFixed(3)} m`);
    check('arroyo del vado (3118,3501) vadeable (0 < d <= 0,35)', vados[1].depth > 0 && vados[1].depth <= 0.35, `${vados[1].depth.toFixed(3)} m`);
    check('cruce seco (3139,3485) en seco (=== 0)', vados[2].depth === 0, `${vados[2].depth}`);

    // ---- 5. Regresión del fix de T4: fuera del anillo con celda a 0,125 m. ----
    // Antes del fix `gridDepthAt` devolvía agua en seco fuera del borde
    // dibujado (21 celdas, peor 0,125 m); ahora la pertenencia al anillo manda.
    const dReg = await depthAt(2619.67, 665.63);
    report.casos.regresion_t4 = { x: 2619.67, z: 665.63, depth: dReg };
    check('regresión T4 (2619.67, 665.63) en seco (=== 0)', dReg === 0, `${dReg}`);

    // ---- 6. Fango derivado del dato (ruling T5). ----
    // El (2150,1230) del plan está a 66 m del anillo —fuera de la banda de
    // 12 m—, así que su `true` sería una coordenada mala, no un fallo del
    // módulo. Se deriva el punto: primer vértice del anillo del embalse cuyo
    // punto a ~5 m por fuera tenga depthAt === 0 y pendiente <20° (la
    // pendiente se mide con window.__game.terrainHeightAt por diferencias
    // finitas a 5 m, como hace water.ts).
    const fango = await cdp.evaluate(`(async () => {
      const w = window.__game.water;
      const TAN20 = 0.364, E = 5;
      const slope = (x, z) => {
        const gx = (window.__game.terrainHeightAt(x + E, z) - window.__game.terrainHeightAt(x - E, z)) / (2 * E);
        const gz = (window.__game.terrainHeightAt(x, z + E) - window.__game.terrainHeightAt(x, z - E)) / (2 * E);
        return Math.hypot(gx, gz);
      };
      const contains = (ring, x, z) => {
        let inside = false;
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
          const a = ring[i], b = ring[j];
          if (a[1] > z !== b[1] > z && x < ((b[0] - a[0]) * (z - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
        }
        return inside;
      };
      const data = await (await fetch('/water/water.json')).json();
      const ring = data.sheets.find((s) => s.kind === 'reservoir').ring;
      const ccx = ring.reduce((a, p) => a + p[0], 0) / ring.length;
      const ccz = ring.reduce((a, p) => a + p[1], 0) / ring.length;
      for (let i = 0; i < ring.length; i++) {
        const p = ring[i];
        const dx = p[0] - ccx, dz = p[1] - ccz;
        const len = Math.hypot(dx, dz) || 1;
        const qx = p[0] + (dx / len) * 5, qz = p[1] + (dz / len) * 5;
        if (contains(ring, qx, qz)) continue; // tiene que estar por fuera
        if (w.depthAt(qx, qz) !== 0) continue;
        const s = slope(qx, qz);
        if (!(s < TAN20)) continue;
        return { x: qx, z: qz, ringIndex: i, depth: 0, slope: s, muddy: w.isMuddy(qx, qz) };
      }
      return null;
    })()`);
    report.casos.fango_derivado = fango;
    check('fango: se derivó un punto del dato', fango !== null, fango ? `anillo[${fango.ringIndex}] -> (${fango.x.toFixed(1)}, ${fango.z.toFixed(1)})` : 'sin candidato');
    if (fango) {
      check('fango: isMuddy === true a 5 m por fuera del anillo', fango.muddy === true, `muddy=${fango.muddy} pendiente=${fango.slope.toFixed(3)}`);
    }
    // Control negativo: el caso malo del plan, fuera de la banda de 12 m.
    const fangoMalo = await cdp.evaluate('window.__game.water.isMuddy(2150, 1230)');
    report.casos.fango_control_negativo = { x: 2150, z: 1230, muddy: fangoMalo };
    check('fango: control negativo (2150,1230) === false', fangoMalo === false, `muddy=${fangoMalo}`);

    // ---- 7. Orilla segura. ----
    // (a) Desde el centro del vaso se aserta el INVARIANTE (null o punto en
    // seco ≤150 m con pendiente <20°): el primer anillo seco medido está a
    // ~125 m (1/16 direcciones) y con el filtro de pendiente puede devolver
    // null; eso es legal (§5.3.4 → fallback de última posición seca en T6).
    const orillaCentro = await cdp.evaluate(`(() => {
      const w = window.__game.water;
      const TAN20 = 0.364, E = 5;
      const p = w.nearestSafeShore(2350, 1300);
      if (!p) return { punto: null };
      const dist = Math.hypot(p.x - 2350, p.z - 1300);
      const gx = (window.__game.terrainHeightAt(p.x + E, p.z) - window.__game.terrainHeightAt(p.x - E, p.z)) / (2 * E);
      const gz = (window.__game.terrainHeightAt(p.x, p.z + E) - window.__game.terrainHeightAt(p.x, p.z - E)) / (2 * E);
      return { punto: p, dist, depth: w.depthAt(p.x, p.z), slope: Math.hypot(gx, gz) };
    })()`);
    report.casos.orilla_desde_centro = orillaCentro;
    const invOk =
      orillaCentro.punto === null ||
      (orillaCentro.dist <= 150 && orillaCentro.depth === 0 && orillaCentro.slope < 0.364);
    check(
      'orilla desde el centro: null o (<=150 m, seco, pendiente <20°)',
      invOk,
      orillaCentro.punto === null ? 'null (legal: §5.3.4)' : `(${orillaCentro.punto.x}, ${orillaCentro.punto.z}) d=${orillaCentro.dist.toFixed(0)} m seco=${orillaCentro.depth === 0} pend=${orillaCentro.slope.toFixed(3)}`,
    );
    // (b) Desde un punto derivado a ~25 m por dentro de la orilla el retorno
    // debe ser no-null: a esa distancia la tierra está al alcance del primer
    // anillo de búsqueda (25 m).
    const orillaCerca = await cdp.evaluate(`(async () => {
      const w = window.__game.water;
      const TAN20 = 0.364, E = 5;
      const slope = (x, z) => {
        const gx = (window.__game.terrainHeightAt(x + E, z) - window.__game.terrainHeightAt(x - E, z)) / (2 * E);
        const gz = (window.__game.terrainHeightAt(x, z + E) - window.__game.terrainHeightAt(x, z - E)) / (2 * E);
        return Math.hypot(gx, gz);
      };
      const contains = (ring, x, z) => {
        let inside = false;
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
          const a = ring[i], b = ring[j];
          if (a[1] > z !== b[1] > z && x < ((b[0] - a[0]) * (z - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
        }
        return inside;
      };
      const data = await (await fetch('/water/water.json')).json();
      const ring = data.sheets.find((s) => s.kind === 'reservoir').ring;
      const ccx = ring.reduce((a, p) => a + p[0], 0) / ring.length;
      const ccz = ring.reduce((a, p) => a + p[1], 0) / ring.length;
      let desde = null;
      for (let i = 0; i < ring.length && !desde; i++) {
        const p = ring[i];
        const dx = ccx - p[0], dz = ccz - p[1];
        const len = Math.hypot(dx, dz) || 1;
        const qx = p[0] + (dx / len) * 25, qz = p[1] + (dz / len) * 25;
        if (!contains(ring, qx, qz)) continue;
        const d = w.depthAt(qx, qz);
        if (!(d > 0.3)) continue; // claramente dentro del agua
        desde = { x: qx, z: qz, ringIndex: i, depth: d };
      }
      if (!desde) return { desde: null };
      const punto = w.nearestSafeShore(desde.x, desde.z);
      if (!punto) return { desde, punto: null };
      return { desde, punto, dist: Math.hypot(punto.x - desde.x, punto.z - desde.z), depth: w.depthAt(punto.x, punto.z), slope: slope(punto.x, punto.z) };
    })()`);
    report.casos.orilla_desde_interior = orillaCerca;
    check('orilla: se derivó un punto interior (~25 m)', orillaCerca.desde !== null, orillaCerca.desde ? `anillo[${orillaCerca.desde.ringIndex}] -> (${orillaCerca.desde.x.toFixed(1)}, ${orillaCerca.desde.z.toFixed(1)}) d=${orillaCerca.desde.depth.toFixed(2)} m` : 'sin candidato');
    if (orillaCerca.desde) {
      check('orilla interior: retorna punto (no-null)', orillaCerca.punto !== null, JSON.stringify(orillaCerca.punto));
      if (orillaCerca.punto) {
        check('orilla interior: a <= 150 m', orillaCerca.dist <= 150, `${orillaCerca.dist.toFixed(1)} m`);
        check('orilla interior: punto en seco', orillaCerca.depth === 0, `${orillaCerca.depth}`);
        check('orilla interior: pendiente < 20°', orillaCerca.slope < 0.364, `${orillaCerca.slope.toFixed(3)}`);
      }
    }

    // ---- 8. Consola sin errores. ----
    report.errores_consola = cdp.errors;
    check('consola sin errores', cdp.errors.length === 0, `${cdp.errors.length} errores`);
    for (const e of cdp.errors) console.error(`[agua-queries]   ${e}`);

    writeFileSync(resolve(OUT_DIR, 'water_queries.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(`\n=> mediciones en ${OUT_DIR}/water_queries.json`);

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
