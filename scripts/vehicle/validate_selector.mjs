// Validador estático del SELECTOR de vehículo (FASE 2: UI).
// Node con cero deps: comprueba el cableado sin abrir el navegador (el
// comportamiento lo cubre scripts/vehicle/drive_selector.mjs).
//
// Verifica:
//   1. `index.html` trae chip, panel (role=dialog, oculto), lista y botón táctil;
//   2. el CSS del selector existe (chip, tarjetas, activa, :focus-visible);
//   3. `src/vehicle/selector.ts` exporta la API y construye las tarjetas desde
//      `VEHICLE_PRESETS` (sin <img: no hay miniaturas falsas);
//   4. `src/main.ts` cablea KeyV, `aplicarPreset` (UI y API comparten camino),
//      y las tres ayudas de teclas mencionan V;
//   5. el nº de presets de `presets.ts` coincide con lo esperado (3).
//
// Uso: node scripts/vehicle/validate_selector.mjs
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const html = readFileSync(resolve(root, 'index.html'), 'utf8');
const selectorSrc = readFileSync(resolve(root, 'src/vehicle/selector.ts'), 'utf8');
const mainSrc = readFileSync(resolve(root, 'src/main.ts'), 'utf8');
const presetsSrc = readFileSync(resolve(root, 'src/vehicle/presets.ts'), 'utf8');

const failures = [];
const check = (nombre, ok, detalle) => {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${nombre}: ${detalle}`);
  if (!ok) failures.push(`${nombre}: ${detalle}`);
};

// --- 1. DOM en index.html ---
check('chip del vehículo en el DOM', /id="vehiculo-chip"/.test(html) && /aria-controls="vehiculos-panel"/.test(html), '#vehiculo-chip + aria-controls');
check('panel como diálogo oculto', /id="vehiculos-panel"/.test(html) && /role="dialog"/.test(html) && /id="vehiculos-panel"[^>]*hidden/.test(html), '#vehiculos-panel role=dialog hidden');
check('lista de tarjetas en el panel', /class="vehiculo-lista"/.test(html), '.vehiculo-lista');
check('botón táctil V en controles móviles', /data-code="KeyV"/.test(html), '#mobile-controls [data-code="KeyV"]');

// --- 2. CSS del selector ---
for (const regla of ['#vehiculo-chip', '#vehiculos-panel', '.vehiculo-tarjeta', '.vehiculo-tarjeta.activa', ':focus-visible']) {
  check(`CSS contiene ${regla}`, html.includes(regla), regla);
}

// --- 3. selector.ts: API y tarjetas desde los datos ---
check('exporta createVehicleSelector', /export function createVehicleSelector/.test(selectorSrc), 'createVehicleSelector');
for (const metodo of ['setCurrent', 'toggle', 'isOpen']) {
  check(`API incluye ${metodo}`, new RegExp(`\\b${metodo}\\b`).test(selectorSrc), metodo);
}
check('tarjetas construidas desde VEHICLE_PRESETS', /for \(const preset of VEHICLE_PRESETS\)/.test(selectorSrc), 'loop sobre VEHICLE_PRESETS');
check('sin miniaturas falsas', !/<img/.test(selectorSrc), 'sin <img en selector.ts');
check('foco gestionado (abrir/cerrar)', /activeElement/.test(selectorSrc) && /canvas\.focus/.test(selectorSrc), 'foco a tarjeta y vuelta al canvas');
check('Escape cierra el panel', /'Escape'/.test(selectorSrc), 'Escape');

// --- 4. main.ts: cableado ---
check('KeyV conmuta el selector', /event\.code === 'KeyV'/.test(mainSrc) && /selectorVehiculo\?\.toggle\(\)/.test(mainSrc), 'keydown KeyV → toggle');
check('UI y API comparten aplicarPreset', /onSelect: \(id\) => \{\s*\n?\s*if \(aplicarPreset\(id\)\)/.test(mainSrc) && /setPreset: \(id: string\) => aplicarPreset\(id\)/.test(mainSrc), 'onSelect + setPreset → aplicarPreset');
check('setCurrent refresca chip y tarjeta', /selectorVehiculo\?\.setCurrent\(preset\.id\)/.test(mainSrc), 'aplicarPreset → setCurrent');
check('botón táctil V con click directo', /#mobile-controls \[data-code="KeyV"\]/.test(mainSrc), 'querySelector KeyV + click');
for (const ayuda of ['TECLAS_CONDUCIENDO', 'TECLAS_A_PIE', 'CONTROLES_LIBRE']) {
  check(`${ayuda} menciona V`, new RegExp(`${ayuda}[\\s\\S]{0,400}V[^a-z]`).test(mainSrc), ayuda);
}

// --- 5. nº de presets ---
const ids = [...presetsSrc.matchAll(/id: '([a-z]+)'/g)].map((m) => m[1]);
check('3 presets en presets.ts', ids.length === 3, ids.join(', '));

if (failures.length > 0) {
  console.error(`\nFALLARON ${failures.length} checks:\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log('\nTODO OK');
