// Medición y captura del AGUA sobre el terreno real (AGUA T4).
// Chrome headless + CDP con el WebSocket nativo de Node (cero deps nuevas),
// mismo patrón que scripts/roads/draping/capture_draping.mjs y
// scripts/milestone/drive_milestone.mjs.
//
// Mide, en la APP REAL:
//   1. delta de draw calls con y sin `?water=0` (esperado >= 2; hay 3 mallas);
//   2. triángulos totales del agua (`window.__game.water.stats()`, <= 40 k);
//   3. residual cinta<->terreno EN LA APP: todos los puntos de eje por
//      `window.__game.terrainHeightAt`, superficie (lerp + caladoM) >=
//      terreno + 0,02 m (0 violaciones);
//   4. `depthAt` en los tres cruces del vado del Oca (tope 0,35 m);
//   5. capturas con la MISMA cámara con y sin agua (presa, vaso, vado, arroyo)
//      más una con `?water=0`; consola sin errores. FPS NO cuenta (SwiftShader).
//
// Uso: node scripts/water/capture_water.mjs [--base http://127.0.0.1:5173]
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
const PORT = Number(arg('--port', '9226'));
const BASE = arg('--base', 'http://127.0.0.1:5173');
const OUT_DIR = resolve(root, arg('--out-dir', 'output'));
const CHROME = arg('--chrome', 'google-chrome');
const PROFILE = '/tmp/opencode/chrome-cdp-profile-water';

// Cruces del vado del Oca en la ruta (AGUA.md §6): depthAt <= 0,35 m.
const VADOS = [
  [3176, 3450],
  [3118, 3501],
  [3139, 3485],
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

  // Puntos de captura calculados del dato (no a mano). Orilla del vaso: se
  // busca un vértice del anillo cuyo interior a 30 m tenga 1–4 m de agua
  // (bilineal del depthGrid, la misma que usa depthAt); la punta este del
  // vaso queda en seco y encuadrarla solo muestra vega.
  const water = JSON.parse(readFileSync(resolve(root, 'public/water/water.json'), 'utf8'));
  const embalse = water.sheets.find((s) => s.kind === 'reservoir');
  const grid = water.depthGrid;
  const gridDepth = (x, z) => {
    const fx = (x - grid.originX) / grid.cellM;
    const fz = (z - grid.originZ) / grid.cellM;
    if (fx < 0 || fz < 0 || fx > grid.cols - 1 || fz > grid.rows - 1) return null;
    const x0 = Math.min(grid.cols - 2, Math.max(0, Math.floor(fx)));
    const z0 = Math.min(grid.rows - 2, Math.max(0, Math.floor(fz)));
    const tx = Math.min(1, Math.max(0, fx - x0));
    const tz = Math.min(1, Math.max(0, fz - z0));
    const at = (c, r) => grid.depthsDm[r * grid.cols + c] / 10;
    const top = at(x0, z0) + (at(x0 + 1, z0) - at(x0, z0)) * tx;
    const bottom = at(x0, z0 + 1) + (at(x0 + 1, z0 + 1) - at(x0, z0 + 1)) * tx;
    return top + (bottom - top) * tz;
  };
  const ring = embalse.ring;
  const ccx = ring.reduce((a, p) => a + p[0], 0) / ring.length;
  const ccz = ring.reduce((a, p) => a + p[1], 0) / ring.length;
  let orilla = null;
  for (const p of ring) {
    const dx = ccx - p[0];
    const dz = ccz - p[1];
    const len = Math.hypot(dx, dz) || 1;
    const ux = dx / len;
    const uz = dz / len;
    const ix = p[0] + ux * 30;
    const iz = p[1] + uz * 30;
    const dep = gridDepth(ix, iz);
    if (dep !== null && dep >= 1 && dep <= 4) {
      orilla = { cam: [p[0] - ux * 60, p[1] - uz * 60], tgt: [ix, iz], depth: dep };
      break;
    }
  }
  if (!orilla) throw new Error('sin orilla con 1–4 m de agua en el anillo del embalse');
  const streams = water.ribbons.filter((r) => r.kind === 'stream').sort((a, b) => b.points.length - a.points.length);
  const arroyo = streams[0].points[Math.floor(streams[0].points.length / 2)];

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
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });

    const report = {
      generado_por: 'scripts/water/capture_water.mjs',
      base: BASE,
      fecha: new Date().toISOString(),
    };

    // ===================== CON AGUA: presa desde aguas arriba =====================
    const presa = { px: 2350, py: 175, pz: 1300, tx: 2434, ty: 150, tz: 1523 };
    console.log('[agua] CON agua: navegando a la presa');
    await cdp.send('Page.navigate', { url: `${BASE}/?${qs(presa)}` });
    await waitReady(cdp, '!!(window.__game && window.__game.water)');
    await wait(2500);

    report.stats = await cdp.evaluate('window.__game.water.stats()');
    console.log(
      `[agua] stats: ${report.stats.sheets} láminas · ${report.stats.ribbons} cintas · ` +
        `${report.stats.meshes} mallas · ${report.stats.triangles} tris · ${report.stats.dataBytes} B`,
    );
    check('agua: 3 mallas', report.stats.meshes === 3, `${report.stats.meshes} mallas`);
    // Cotas INFERIORES: sin ellas, un fallo de carga (sheets/ribbons vacíos)
    // pasaría todos los checks (residual=0 muestras, triángulos bajo el tope).
    check(
      'agua: láminas y cintas presentes',
      report.stats.sheets >= 5 && report.stats.ribbons >= 50,
      `${report.stats.sheets} láminas · ${report.stats.ribbons} cintas`,
    );
    check('agua: triángulos >= 30 k (piso)', report.stats.triangles >= 30000, `${report.stats.triangles} tris`);
    check('agua: triángulos <= 40 k', report.stats.triangles <= 40000, `${report.stats.triangles} tris`);

    const perfCon = await cdp.evaluate('window.__game.perf()');
    // Solo métricas válidas en headless: FPS/frameTime de SwiftShader no se
    // persisten en el JSON (inducen a error si se leen como medición).
    report.perf_con_agua = { drawCalls: perfCon.drawCalls, triangles: perfCon.triangles };
    console.log(`[agua] con agua (presa): draw=${perfCon.drawCalls} tris=${perfCon.triangles.toFixed(0)}`);

    // ===================== Residual cinta<->terreno EN LA APP =====================
    // Todos los segmentos del eje, 5 muestras por segmento: superficie
    // (lerp de cotas + caladoM, en absoluto) contra terrainHeightAt (mundo) +
    // datum. La invariante de T3 dice >= +0,02 m en TODO el eje.
    console.log('[agua] residual: recorriendo todos los ejes en la app…');
    const residual = await cdp.evaluate(`(async () => {
      const datum = window.__game.auditDatum().verticalDatum;
      const data = await (await fetch('/water/water.json')).json();
      let checked = 0, violations = 0, worst = Infinity, worstAt = null;
      for (const r of data.ribbons) {
        const pts = r.points, cal = r.caladoM;
        for (let i = 0; i + 1 < pts.length; i++) {
          const ax = pts[i][0], az = pts[i][1], ay = pts[i][2];
          const bx = pts[i + 1][0], bz = pts[i + 1][1], by = pts[i + 1][2];
          for (const t of [0, 0.25, 0.5, 0.75, 1]) {
            const x = ax + (bx - ax) * t, z = az + (bz - az) * t;
            const surf = ay + (by - ay) * t + cal;
            const terr = window.__game.terrainHeightAt(x, z) + datum;
            const h = surf - terr;
            checked++;
            if (h < worst) { worst = h; worstAt = [x, z]; }
            if (h < 0.02 - 1e-9) violations++;
          }
        }
      }
      return { checked, violations, worst, worstAt };
    })()`);
    report.residual = residual;
    console.log(
      `[agua] residual: ${residual.checked} muestras · violaciones=${residual.violations} · ` +
        `peor=${residual.worst.toFixed(3)} m en (${residual.worstAt.map((v) => v.toFixed(1)).join(', ')})`,
    );
    check('agua: residual con muestras (no vacío)', residual.checked >= 15000, `${residual.checked} muestras`);
    check('agua: residual >= +0,02 m en todo el eje', residual.violations === 0, `${residual.violations} violaciones`);

    // ===================== Vados: depthAt <= 0,35 m =====================
    const vados = await cdp.evaluate(
      `(() => { const w = window.__game.water; return ${JSON.stringify(VADOS)}.map(([x, z]) => ({ x, z, depth: w.depthAt(x, z) })); })()`,
    );
    report.vados = vados;
    for (const v of vados) {
      console.log(`[agua] vado (${v.x}, ${v.z}): depthAt=${v.depth.toFixed(3)} m`);
      check(`agua: vado (${v.x}, ${v.z}) <= 0,35 m`, v.depth <= 0.35, `${v.depth.toFixed(3)} m`);
    }

    // ===================== Capturas =====================
    const groundAt = async (x, z) => cdp.evaluate(`window.__game.terrainHeightAt(${x}, ${z})`);

    async function capture(name, view) {
      await cdp.send('Page.navigate', { url: `${BASE}/?${qs(view)}` });
      await waitReady(cdp, '!!window.__game');
      await wait(2500);
      await cdp.screenshot(resolve(OUT_DIR, `${name}.png`));
      console.log(`[agua] captura output/${name}.png`);
    }

    // (a) presa desde aguas arriba (cámara fijada por el plan).
    await capture('water_presa', presa);

    // (b) orilla del vaso: desde fuera del anillo mirando al agua (1–4 m).
    const gOrilla = await groundAt(orilla.cam[0], orilla.cam[1]);
    console.log(`[agua] orilla del vaso: profundidad ${orilla.depth.toFixed(2)} m en el objetivo`);
    await capture('water_vaso', {
      px: orilla.cam[0], py: gOrilla + 20, pz: orilla.cam[1],
      tx: orilla.tgt[0], ty: gOrilla, tz: orilla.tgt[1],
    });

    // (c) vado del Oca: el cruce con el agua a los lados (ruling: la pista tapa
    // la cinta en el punto exacto del cruce; la captura decide si se ve agua).
    const gVado = await groundAt(VADOS[0][0], VADOS[0][1]);
    await capture('water_vado', {
      px: VADOS[0][0] - 55, py: gVado + 20, pz: VADOS[0][1] - 55, tx: VADOS[0][0], ty: gVado, tz: VADOS[0][1],
    });

    // (d) un arroyo (punto medio del más largo).
    const gArroyo = await groundAt(arroyo[0], arroyo[1]);
    await capture('water_arroyo', {
      px: arroyo[0] + 28, py: gArroyo + 14, pz: arroyo[1] - 28, tx: arroyo[0], ty: gArroyo, tz: arroyo[1],
    });

    // ===================== SIN AGUA: misma cámara de la presa =====================
    console.log('[agua] SIN agua: misma cámara de la presa con ?water=0');
    await cdp.send('Page.navigate', { url: `${BASE}/?${qs({ ...presa, water: 0 })}` });
    await waitReady(cdp, '!!(window.__game && window.__game.water === null)');
    await wait(2500);
    const perfSin = await cdp.evaluate('window.__game.perf()');
    report.perf_sin_agua = { drawCalls: perfSin.drawCalls, triangles: perfSin.triangles };
    report.costo_agua = {
      draw_calls_sin: perfSin.drawCalls,
      draw_calls_con: perfCon.drawCalls,
      draw_calls_delta: perfCon.drawCalls - perfSin.drawCalls,
      triangulos_sin: Math.round(perfSin.triangles),
      triangulos_con: Math.round(perfCon.triangles),
      triangulos_delta: Math.round(perfCon.triangles - perfSin.triangles),
    };
    console.log(
      `[agua] draw calls ${perfSin.drawCalls} -> ${perfCon.drawCalls} ` +
        `(+${perfCon.drawCalls - perfSin.drawCalls}) · ` +
        `tris ${perfSin.triangles.toFixed(0)} -> ${perfCon.triangles.toFixed(0)}`,
    );
    check('agua: delta draw calls >= 2', perfCon.drawCalls - perfSin.drawCalls >= 2, `${perfSin.drawCalls} -> ${perfCon.drawCalls}`);
    check(
      'agua: triángulos del agua en vista >= 30 k',
      report.costo_agua.triangulos_delta >= 30000,
      `${report.costo_agua.triangulos_delta} tris`,
    );
    await cdp.screenshot(resolve(OUT_DIR, 'water_presa_sin_agua.png'));
    console.log('[agua] captura output/water_presa_sin_agua.png');

    report.errores_consola = cdp.errors;
    report.perf_nota =
      'FPS y frame time en Chrome headless con SwiftShader (CPU). NO representan el rendimiento en GPU. ' +
      'draw calls y triángulos sí son válidos.';
    check('agua: consola sin errores', cdp.errors.length === 0, `${cdp.errors.length} errores`);
    for (const e of cdp.errors) console.error(`[agua]   ${e}`);

    writeFileSync(resolve(OUT_DIR, 'water_capture.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(`\n=> mediciones y capturas en ${OUT_DIR}`);

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
