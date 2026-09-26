// Arnés del SELECTOR de vehículo (FASE 2: chip + panel de tarjetas).
// Chrome headless + CDP con el WebSocket nativo de Node (cero deps nuevas),
// mismo andamiaje que scripts/vehicle/drive_presets.mjs.
//
// Prueba contra la APP REAL, en modo misión normal (a pie, no ?player=0: el
// selector es UI y debe funcionar en el juego tal cual arranca):
//   1. arranque: chip visible con "Estándar", panel oculto;
//   2. V abre el panel: 3 tarjetas (las de VEHICLE_PRESETS), activa = estándar,
//      foco dentro del panel, chip con aria-expanded=true;
//   3. clic en la tarjeta "carga": preset carga (mass 2400), chip "Carga",
//      tarjeta marcada, panel cerrado y foco devuelto al canvas;
//   4. V reabre, Escape cierra;
//   5. vía teclado: V, foco a "patrulla", Enter → preset patrulla y cierra;
//   6. recarga con localStorage `selectedVehicleId=carga`: chip y tarjeta en carga;
//   7. el botón táctil `data-code="KeyV"` existe en el DOM;
//   8. consola sin errores. Reporte en output/vehicle_selector.json.
//
// Uso: node scripts/vehicle/drive_selector.mjs [--base http://127.0.0.1:5173]
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
const PORT = Number(arg('--port', '9230'));
const BASE = arg('--base', 'http://127.0.0.1:5173');
const OUT_DIR = resolve(root, arg('--out-dir', 'output'));
const CHROME = arg('--chrome', 'google-chrome');
const PROFILE = '/tmp/opencode/chrome-cdp-profile-vehicle-selector';

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
  /** Pulsa una tecla física (llega como KeyboardEvent real a window). */
  async key(code, key) {
    // La activación nativa de un <button> con Enter exige el keyCode Windows
    // real (13) MÁS text/unmodifiedText '\r' (verificado con sonda: sin ellos
    // el navegador entrega el evento pero no dispara el clic).
    const KEY_CODES = { Enter: 13, Escape: 27, ' ': 32 };
    const KEY_EXTRAS = { Enter: { text: '\r', unmodifiedText: '\r' } };
    const vk = KEY_CODES[key] ?? (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0);
    const base = { code, key, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, ...(KEY_EXTRAS[key] ?? {}) };
    await this.send('Input.dispatchKeyEvent', { ...base, type: 'keyDown' });
    await this.send('Input.dispatchKeyEvent', { ...base, type: 'keyUp' });
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

const ESTADO_UI = `(() => {
  const chip = document.getElementById('vehiculo-chip');
  const panel = document.getElementById('vehiculos-panel');
  const cards = panel ? Array.from(panel.querySelectorAll('.vehiculo-tarjeta')) : [];
  const activa = cards.find((c) => c.classList.contains('activa'));
  return {
    chip: chip ? chip.textContent : null,
    chipExpanded: chip ? chip.getAttribute('aria-expanded') : null,
    panelOculto: panel ? panel.hidden : null,
    tarjetas: cards.map((c) => c.dataset.preset),
    activa: activa ? activa.dataset.preset : null,
    focoEnPanel: panel ? panel.contains(document.activeElement) : false,
    focoEnCanvas: document.activeElement ? document.activeElement.id === 'render-canvas' : false,
    botonTactilV: !!document.querySelector('#mobile-controls [data-code="KeyV"]'),
  };
})()`;

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
  const report = { generado_por: 'scripts/vehicle/drive_selector.mjs', base: BASE, fecha: new Date().toISOString() };

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

    console.log('[selector] arranque en modo misión (perfil limpio)');
    await cdp.send('Page.navigate', { url: `${BASE}/` });
    await waitReady(cdp, '!!(window.__game && window.__game.vehicle)');
    await wait(2500);

    // ---- 1. arranque: chip en Estándar, panel oculto. ----
    const arranque = await cdp.evaluate(ESTADO_UI);
    report.arranque = arranque;
    check('chip visible con el preset por defecto', arranque.chip !== null && arranque.chip.includes('Estándar'), JSON.stringify(arranque.chip));
    check('panel oculto al arrancar', arranque.panelOculto === true, JSON.stringify(arranque.panelOculto));
    check('botón táctil V presente en el DOM', arranque.botonTactilV === true, JSON.stringify(arranque.botonTactilV));

    // ---- 2. V abre: 3 tarjetas, activa estándar, foco dentro. ----
    await cdp.key('KeyV', 'v');
    await wait(600);
    const abierto = await cdp.evaluate(ESTADO_UI);
    report.abierto = abierto;
    check('V abre el panel', abierto.panelOculto === false, JSON.stringify(abierto.panelOculto));
    check('3 tarjetas (las de VEHICLE_PRESETS)', JSON.stringify(abierto.tarjetas) === JSON.stringify(['estandar', 'patrulla', 'carga']), JSON.stringify(abierto.tarjetas));
    check('activa = estandar', abierto.activa === 'estandar', JSON.stringify(abierto.activa));
    check('foco dentro del panel', abierto.focoEnPanel === true, JSON.stringify(abierto.focoEnPanel));
    check('chip con aria-expanded=true', abierto.chipExpanded === 'true', JSON.stringify(abierto.chipExpanded));

    // ---- 3. clic en "carga": aplica, marca, cierra y devuelve el foco. ----
    await cdp.evaluate("document.querySelector('.vehiculo-tarjeta[data-preset=\"carga\"]').click()");
    await wait(600);
    const trasClic = await cdp.evaluate(
      `(() => { const ui = (${ESTADO_UI}); return { ...ui, preset: window.__game.vehicle.preset(), mass: window.__game.vehicle.params().mass }; })()`,
    );
    report.tras_clic_carga = trasClic;
    check('clic aplica el preset carga', trasClic.preset === 'carga' && trasClic.mass === 2400, `preset=${trasClic.preset} mass=${trasClic.mass}`);
    check('chip muestra Carga', trasClic.chip !== null && trasClic.chip.includes('Carga'), JSON.stringify(trasClic.chip));
    check('tarjeta carga marcada', trasClic.activa === 'carga', JSON.stringify(trasClic.activa));
    check('elegir cierra el panel', trasClic.panelOculto === true, JSON.stringify(trasClic.panelOculto));
    check('foco devuelto al canvas', trasClic.focoEnCanvas === true, JSON.stringify(trasClic.focoEnCanvas));

    // ---- 4. V reabre, Escape cierra. ----
    await cdp.key('KeyV', 'v');
    await wait(400);
    const reabierto = await cdp.evaluate('document.getElementById("vehiculos-panel").hidden');
    await cdp.key('Escape', 'Escape');
    await wait(400);
    const trasEsc = await cdp.evaluate(ESTADO_UI);
    check('V reabre el panel', reabierto === false, JSON.stringify(reabierto));
    check('Escape cierra el panel', trasEsc.panelOculto === true, JSON.stringify(trasEsc.panelOculto));
    report.escape = { reabierto, cerrado: trasEsc.panelOculto };

    // ---- 5. vía teclado: V, foco a patrulla, Enter. ----
    await cdp.key('KeyV', 'v');
    await wait(400);
    await cdp.evaluate("document.querySelector('.vehiculo-tarjeta[data-preset=\"patrulla\"]').focus()");
    await cdp.key('Enter', 'Enter');
    await wait(600);
    const trasEnter = await cdp.evaluate(
      `(() => { const ui = (${ESTADO_UI}); return { ...ui, preset: window.__game.vehicle.preset(), mass: window.__game.vehicle.params().mass }; })()`,
    );
    report.tras_enter_patrulla = { preset: trasEnter.preset, mass: trasEnter.mass, panelOculto: trasEnter.panelOculto };
    check('Enter aplica el preset patrulla', trasEnter.preset === 'patrulla' && trasEnter.mass === 1200, `preset=${trasEnter.preset} mass=${trasEnter.mass}`);
    check('Enter cierra el panel', trasEnter.panelOculto === true, JSON.stringify(trasEnter.panelOculto));

    // ---- 6. persistencia: recarga con localStorage=carga. ----
    await cdp.evaluate("window.localStorage.setItem('selectedVehicleId', 'carga')");
    await cdp.send('Page.navigate', { url: `${BASE}/` });
    await waitReady(cdp, '!!(window.__game && window.__game.vehicle)');
    await wait(1500);
    const persistido = await cdp.evaluate(ESTADO_UI);
    report.persistido = { chip: persistido.chip, activa: persistido.activa };
    check('recarga con storage=carga restaura chip y tarjeta', (persistido.chip ?? '').includes('Carga') && persistido.activa === 'carga', `chip=${persistido.chip} activa=${persistido.activa}`);

    // ---- 8. consola sin errores. ----
    check('consola sin errores', cdp.errors.length === 0, cdp.errors.length === 0 ? '0 errores' : cdp.errors.join(' | '));
    report.errores_consola = cdp.errors;

    writeFileSync(resolve(OUT_DIR, 'vehicle_selector.json'), `${JSON.stringify(report, null, 2)}\n`);
    console.log(`=> reporte en ${resolve(OUT_DIR, 'vehicle_selector.json')}`);
  } finally {
    chrome.kill('SIGTERM');
  }

  if (failures.length > 0) {
    console.error(`\nFALLARON ${failures.length} checks:\n- ${failures.join('\n- ')}`);
    process.exitCode = 1;
  } else {
    console.log('\nTODO OK');
  }
}

main().catch((error) => {
  console.error(`[selector] FALLO: ${error.message}`);
  process.exitCode = 1;
});
