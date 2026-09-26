// Arnés de las REGLAS del 4x4 en el agua (AGUA T6).
// Chrome headless + CDP con el WebSocket nativo de Node (cero deps nuevas),
// mismo patrón que scripts/water/test_water_queries.mjs y
// scripts/milestone/drive_milestone.mjs.
//
// Prueba contra la APP REAL (paso de simulación de src/main.ts):
//   (a) entrando al vaso, `depthAt` crece y supera 1,1 m (o aparece hundimiento);
//   (b) aparece el estado de hundimiento (`estadoAgua() === 'hundiendo'`) con
//       calado visual > 0;
//   (c) termina en tierra (`depthAt` 0) con velocidad ~0 (‖v‖ < 0,05);
//   (d) el `#aviso` está visible con el texto exacto;
//   (e) caso de arrastre: en 0,35–1,1 m la velocidad no supera el objetivo
//       (~3,5 m/s) mientras el 4x4 avanza de verdad (anti-casualidad);
//   (f) caso de enfangado: banda de fango derivada del dato (como en
//       test_water_queries.mjs), freno + gas >3 s sin avanzar → a la orilla;
//   (g) con `?water=0` no hay reglas activas (`window.__game.water === null`)
//       ni aviso;
//   (h) consola sin errores. Mediciones en output/water_drive.json (gitignorado).
//
// Todo lo pesado (miles de `player.step`) corre DENTRO de la página para no
// hacer un round-trip CDP por frame. Determinista: transectos y puntos de fango
// se derivan del dato (`/water/water.json`), no se inventan.
//
// Uso: node scripts/water/drive_water.mjs [--base http://127.0.0.1:5173]
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
const PORT = Number(arg('--port', '9228'));
const BASE = arg('--base', 'http://127.0.0.1:5173');
const OUT_DIR = resolve(root, arg('--out-dir', 'output'));
const CHROME = arg('--chrome', 'google-chrome');
const PROFILE = '/tmp/opencode/chrome-cdp-profile-water-drive';
const AVISO_TEXTO = 'El 4x4 se hundió — volvés a la orilla';

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
window.__harnessAgua = (function () {
  var g = window.__game;
  var DT = 1 / 60;
  var TAN20 = 0.364;

  function slopeTan(x, z) {
    var E = 5;
    var gx = (g.terrainHeightAt(x + E, z) - g.terrainHeightAt(x - E, z)) / (2 * E);
    var gz = (g.terrainHeightAt(x, z + E) - g.terrainHeightAt(x, z - E)) / (2 * E);
    return Math.hypot(gx, gz);
  }

  function aviso() {
    var el = document.getElementById('aviso');
    if (!el) return { existe: false, visible: false, texto: null };
    return { existe: true, visible: !el.hidden, texto: el.textContent };
  }

  // Deja el 4x4 conduciendo en (x,z) con guiñada yaw (rad). Devuelve el modo.
  function ensureDriving(x, z, yaw) {
    if (g.player.mode() === 'driving') {
      g.player.teleport(x, z, yaw);
    } else {
      g.vehicle.teleport(x, z, yaw);
      g.player.teleport(x + 2, z, yaw);
      g.player.inject({ toggle: true });
      g.player.step(0.1, DT);
      g.player.inject(null);
    }
    return g.player.mode();
  }

  // Transectos orilla->vaso derivados del anillo del embalse: punto en seco a
  // 30 m por fuera (pendiente <20°) apuntando al centro, con >1,1 m a 60 m
  // por dentro. Como en capture_water.mjs, nada a mano.
  function transectos() {
    return fetch('/water/water.json').then(function (r) { return r.json(); }).then(function (data) {
      var ring = null;
      for (var i = 0; i < data.sheets.length; i++) {
        if (data.sheets[i].kind === 'reservoir') ring = data.sheets[i].ring;
      }
      if (!ring) return [];
      var ccx = 0, ccz = 0, k;
      for (k = 0; k < ring.length; k++) { ccx += ring[k][0]; ccz += ring[k][1]; }
      ccx /= ring.length; ccz /= ring.length;
      var out = [];
      for (k = 0; k < ring.length && out.length < 4; k += 7) {
        var p = ring[k];
        var dx = p[0] - ccx, dz = p[1] - ccz;
        var len = Math.hypot(dx, dz) || 1;
        var ox = dx / len, oz = dz / len;
        var qx = p[0] + ox * 30, qz = p[1] + oz * 30;
        if (g.water.depthAt(qx, qz) !== 0) continue;
        if (slopeTan(qx, qz) >= TAN20) continue;
        var ix = p[0] - ox * 60, iz = p[1] - oz * 60;
        if (!(g.water.depthAt(ix, iz) > 1.1)) continue;
        out.push({ qx: qx, qz: qz, yaw: Math.atan2(ccx - qx, ccz - qz), ix: ix, iz: iz });
      }
      return out;
    });
  }

  // Punto de fango derivado del dato (ruling T5): 5 m por fuera del anillo,
  // en seco, pendiente <20° e isMuddy true.
  function puntoFango() {
    return fetch('/water/water.json').then(function (r) { return r.json(); }).then(function (data) {
      var ring = null;
      for (var i = 0; i < data.sheets.length; i++) {
        if (data.sheets[i].kind === 'reservoir') ring = data.sheets[i].ring;
      }
      if (!ring) return null;
      var contiene = function (x, z) {
        var inside = false;
        for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
          var a = ring[i], b = ring[j];
          if (a[1] > z !== b[1] > z && x < ((b[0] - a[0]) * (z - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
        }
        return inside;
      };
      var ccx = 0, ccz = 0, k;
      for (k = 0; k < ring.length; k++) { ccx += ring[k][0]; ccz += ring[k][1]; }
      ccx /= ring.length; ccz /= ring.length;
      for (k = 0; k < ring.length; k++) {
        var p = ring[k];
        var dx = p[0] - ccx, dz = p[1] - ccz;
        var len = Math.hypot(dx, dz) || 1;
        var qx = p[0] + (dx / len) * 5, qz = p[1] + (dz / len) * 5;
        if (contiene(qx, qz)) continue;
        if (g.water.depthAt(qx, qz) !== 0) continue;
        if (slopeTan(qx, qz) >= TAN20) continue;
        if (!g.water.isMuddy(qx, qz)) continue;
        return { x: qx, z: qz, ringIndex: k, yawFuera: Math.atan2(qx - ccx, qz - ccz) };
      }
      return null;
    });
  }

  // (a)-(d): gas a fondo desde la orilla hacia el centro hasta el rescate.
  function escenarioHondo(c) {
    var pre = document.getElementById('aviso');
    if (pre) pre.hidden = true; // limpia un rescate anterior: solo vale el propio
    if (ensureDriving(c.qx, c.qz, c.yaw) !== 'driving') return { ok: false, motivo: 'no-driving' };
    var maxD = 0, maxCal = 0, sawHund = false, sawArr = false, sim = 0, stuckS = 0;
    var muestras = [], rescatado = false;
    g.player.inject({ throttle: 1, steer: 0, handbrake: false, neutral: false });
    while (sim < 45) {
      g.player.step(DT, DT);
      sim += DT;
      var t = g.player.telemetry();
      var d = g.water.depthAt(t.x, t.z);
      var e = g.water.estadoAgua();
      var cal = g.water.calado();
      if (d > maxD) maxD = d;
      if (e === 'hundiendo') { sawHund = true; if (cal > maxCal) maxCal = cal; }
      if (e === 'arrastrando') sawArr = true;
      if (Math.abs(Math.round(sim * 4) - sim * 4) < DT / 2) {
        muestras.push({ t: +sim.toFixed(2), x: +t.x.toFixed(1), z: +t.z.toFixed(1), d: +d.toFixed(2), e: e, v: +t.speedMps.toFixed(2) });
      }
      var av = aviso();
      if (av.visible) { rescatado = true; break; }
      if (Math.abs(t.speedMps) < 0.5 && d <= 1.1) stuckS += DT; else stuckS = 0;
      if (stuckS > 6 && !sawHund) break; // clavado en la orilla: otro transecto
    }
    g.player.inject({});
    g.player.step(1.0, DT);
    var tf = g.player.telemetry();
    var av2 = aviso();
    return {
      ok: sawHund, motivo: sawHund ? null : 'sin-hundimiento',
      maxD: maxD, maxCaladoHundiendo: maxCal, vioArrastre: sawArr, vioHundimiento: sawHund,
      rescatado: rescatado, avisoVisible: av2.visible, avisoTexto: av2.texto,
      fin: { x: tf.x, z: tf.z, d: g.water.depthAt(tf.x, tf.z), v: tf.speedMps, e: g.water.estadoAgua() },
      muestras: muestras, simS: sim
    };
  }

  // (e): en la banda 0,35-1,1 m, a fondo, la velocidad no supera el objetivo.
  function escenarioArrastre(c) {
    // Punto somero (~0,5-0,9 m) barriendo del transecto hacia el centro.
    var sx = 0, sz = 0, encontrado = false;
    for (var s = 10; s <= 120 && !encontrado; s += 5) {
      var px = c.qx + (c.ix - c.qx) * (s / 120), pz = c.qz + (c.iz - c.qz) * (s / 120);
      var dd = g.water.depthAt(px, pz);
      if (dd >= 0.5 && dd <= 0.9 && slopeTan(px, pz) < TAN20) { sx = px; sz = pz; encontrado = true; }
    }
    if (!encontrado) return { ok: false, motivo: 'sin-banda-somera' };
    // Rumbo perpendicular al gradiente de profundidad: navega POR la banda.
    var E = 2;
    var gx = (g.water.depthAt(sx + E, sz) - g.water.depthAt(sx - E, sz)) / (2 * E);
    var gz = (g.water.depthAt(sx, sz + E) - g.water.depthAt(sx, sz - E)) / (2 * E);
    var gl = Math.hypot(gx, gz) || 1;
    var yaw = Math.atan2(-gz / gl, gx / gl);
    if (ensureDriving(sx, sz, yaw) !== 'driving') return { ok: false, motivo: 'no-driving' };
    var maxV = 0, sumaV = 0, n = 0, dMin = Infinity, dMax = -Infinity, truncado = false;
    g.player.inject({ throttle: 1, steer: 0, handbrake: false, neutral: false });
    var sim = 0;
    while (sim < 8) {
      g.player.step(DT, DT);
      sim += DT;
      var t = g.player.telemetry();
      var d = g.water.depthAt(t.x, t.z);
      if (g.water.estadoAgua() === 'hundiendo') { truncado = true; break; }
      if (d > 0.35 && d <= 1.1) {
        var v = Math.abs(t.speedMps);
        if (v > maxV) maxV = v;
        sumaV += v; n++;
        if (d < dMin) dMin = d;
        if (d > dMax) dMax = d;
      }
    }
    g.player.inject({});
    return {
      ok: true, desde: { x: sx, z: sz, d: g.water.depthAt(sx, sz) },
      maxV: maxV, mediaV: n ? sumaV / n : 0, nBanda: n,
      dMin: n ? dMin : null, dMax: n ? dMax : null, truncado: truncado, simS: sim
    };
  }

  // (f): en el fango, frenado y con gas >3 s sin avanzar → a la orilla.
  function escenarioFango(m) {
    var pre = document.getElementById('aviso');
    if (pre) pre.hidden = true; // limpia un rescate anterior: solo vale el propio
    if (ensureDriving(m.x, m.z, m.yawFuera) !== 'driving') return { ok: false, motivo: 'no-driving' };
    var sawEnf = false, sim = 0;
    g.player.inject({ throttle: 1, steer: 0, handbrake: true, neutral: false });
    while (sim < 12) {
      g.player.step(DT, DT);
      sim += DT;
      if (g.water.estadoAgua() === 'enfangado') sawEnf = true;
      if (aviso().visible) break;
    }
    // Reposo frenado: sin freno el 4x4 puede escurrirse en la pendiente y la
    // lectura de "detenido" mediría la ladera, no el rescate.
    g.player.inject({ throttle: 0, steer: 0, handbrake: true, neutral: false });
    g.player.step(1.0, DT);
    var tf = g.player.telemetry();
    var av2 = aviso();
    return {
      ok: sawEnf, vioEnfangado: sawEnf,
      avisoVisible: av2.visible, avisoTexto: av2.texto,
      fin: { x: tf.x, z: tf.z, d: g.water.depthAt(tf.x, tf.z), v: tf.speedMps, e: g.water.estadoAgua() },
      simS: sim
    };
  }

  return { transectos: transectos, puntoFango: puntoFango, escenarioHondo: escenarioHondo, escenarioArrastre: escenarioArrastre, escenarioFango: escenarioFango, aviso: aviso };
})();
'ok';
`;

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
  const report = { generado_por: 'scripts/water/drive_water.mjs', base: BASE, fecha: new Date().toISOString() };

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

    console.log('[agua-drive] navegando a la app (con agua)');
    await cdp.send('Page.navigate', { url: `${BASE}/` });
    await waitReady(cdp, '!!(window.__game && window.__game.water && window.__game.player && window.__game.vehicle)');
    await wait(2500);
    await cdp.evaluate(HARNESS_SOURCE);

    const transectos = await cdp.evaluate('window.__harnessAgua.transectos()');
    report.transectos = transectos;
    check('drive: hay transectos orilla->vaso derivados del dato', transectos.length > 0, `${transectos.length} candidatos`);

    // ---- (a)-(d): inmersión profunda con el primer transecto que hunda. ----
    let hondo = null;
    const intentos = [];
    for (const c of transectos) {
      const r = await cdp.evaluate(`window.__harnessAgua.escenarioHondo(${JSON.stringify(c)})`);
      intentos.push({ desde: [c.qx, c.qz], maxD: r.maxD, ok: r.ok, motivo: r.motivo ?? null });
      if (r.ok) {
        hondo = r;
        break;
      }
    }
    report.hondo_intentos = intentos;
    report.hondo = hondo;
    check('drive: algún transecto hunde el 4x4', hondo !== null, hondo ? `maxD=${hondo.maxD.toFixed(2)} m` : JSON.stringify(intentos));
    if (hondo) {
      check('drive (a): depthAt supera 1,1 m al entrar', hondo.maxD > 1.1, `${hondo.maxD.toFixed(2)} m`);
      check("drive (b): aparece 'hundiendo' con calado visual", hondo.vioHundimiento && hondo.maxCaladoHundiendo > 0.3, `hundiendo=${hondo.vioHundimiento} calado=${hondo.maxCaladoHundiendo.toFixed(2)} m`);
      check('drive (c): termina en tierra y detenido', hondo.fin.d === 0 && Math.abs(hondo.fin.v) < 0.05, `d=${hondo.fin.d} v=${hondo.fin.v.toFixed(3)} m/s estado=${hondo.fin.e}`);
      check('drive (d): #aviso visible con el texto exacto', hondo.avisoVisible === true && hondo.avisoTexto === AVISO_TEXTO, JSON.stringify(hondo.avisoTexto));
      report.hondo.muestras = hondo.muestras.filter((_, i) => i % 4 === 0);
    }

    // ---- (e): arrastre en la banda 0,35–1,1 m. ----
    const arrastre = await cdp.evaluate(`window.__harnessAgua.escenarioArrastre(${JSON.stringify(transectos[0])})`);
    report.arrastre = arrastre;
    if (arrastre.ok) {
      check('drive (e): en arrastre no supera ~3,5 m/s', arrastre.maxV <= 3.8, `máx=${arrastre.maxV.toFixed(2)} m/s en ${arrastre.nBanda} cuadros (d ${arrastre.dMin?.toFixed(2)}–${arrastre.dMax?.toFixed(2)} m)`);
      check('drive (e): el 4x4 avanzaba de verdad (no atascado)', arrastre.mediaV > 1.5, `media=${arrastre.mediaV.toFixed(2)} m/s`);
    } else {
      check('drive (e): banda de arrastre medible', false, arrastre.motivo);
    }

    // ---- (f): enfangado (>3 s sin avanzar con gas → orilla). ----
    const fango = await cdp.evaluate('window.__harnessAgua.puntoFango()');
    report.fango_punto = fango;
    check('drive (f): punto de fango derivado del dato', fango !== null, fango ? `anillo[${fango.ringIndex}] -> (${fango.x.toFixed(1)}, ${fango.z.toFixed(1)})` : 'sin candidato');
    if (fango) {
      const enf = await cdp.evaluate(`window.__harnessAgua.escenarioFango(${JSON.stringify(fango)})`);
      report.enfangado = enf;
      check("drive (f): aparece 'enfangado'", enf.vioEnfangado === true, `enfangado=${enf.vioEnfangado} (${enf.simS.toFixed(1)} s sim)`);
      check('drive (f): vuelve a la orilla detenido', enf.fin.d === 0 && Math.abs(enf.fin.v) < 0.05, `d=${enf.fin.d} v=${enf.fin.v.toFixed(3)} m/s`);
      check('drive (f): aviso visible con el texto exacto', enf.avisoVisible === true && enf.avisoTexto === AVISO_TEXTO, JSON.stringify(enf.avisoTexto));
    }

    // ---- (g): ?water=0 apaga reglas y aviso. ----
    await cdp.send('Page.navigate', { url: `${BASE}/?water=0` });
    await waitReady(cdp, '!!(window.__game && window.__game.water === null)');
    await wait(1500);
    const apagado = await cdp.evaluate(
      "(() => ({ agua: window.__game.water, aviso: document.getElementById('aviso') ? document.getElementById('aviso').hidden : null }))()",
    );
    report.apagado = apagado;
    check('drive (g): ?water=0 sin reglas ni aviso', apagado.agua === null && apagado.aviso === true, JSON.stringify(apagado));

    // ---- (h): consola sin errores. ----
    report.errores_consola = cdp.errors;
    check('drive (h): consola sin errores', cdp.errors.length === 0, `${cdp.errors.length} errores`);
    for (const e of cdp.errors) console.error(`[agua-drive]   ${e}`);

    writeFileSync(resolve(OUT_DIR, 'water_drive.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(`\n=> mediciones en ${OUT_DIR}/water_drive.json`);

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
