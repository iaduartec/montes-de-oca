// Validador estático del SELECTOR de vehículo (Tarea 6: catálogo de 8 opciones).
// Node con cero deps: comprueba el cableado sin abrir el navegador (el
// comportamiento lo cubre scripts/vehicle/drive_selector.mjs).
//
// Verifica:
//   1. `index.html` trae chip, panel (role=dialog, oculto), lista y botón táctil;
//   2. el CSS del selector existe (chip, grupos, tarjetas, activa, :focus-visible);
//   3. `src/vehicle/selector.ts` exporta la API y construye 8 tarjetas en 3 grupos
//      desde `VEHICLE_CATALOG` (sin <img: no hay miniaturas falsas);
//   4. `src/main.ts` cablea KeyV y el cambio atómico (`cambiarVehiculo`) para la UI
//      y la API de depuración, y las tres ayudas de teclas mencionan V;
//   5. el catálogo tiene 8 ids únicos en 3 categorías (4/2/2).
//
// Uso: node scripts/vehicle/validate_selector.mjs
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const html = readFileSync(resolve(root, 'index.html'), 'utf8');
const selectorSrc = readFileSync(resolve(root, 'src/vehicle/selector.ts'), 'utf8');
const mainSrc = readFileSync(resolve(root, 'src/main.ts'), 'utf8');

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
for (const regla of ['#vehiculo-chip', '#vehiculos-panel', '.vehiculo-tarjeta', '.vehiculo-tarjeta.activa', '.vehiculo-grupo', '.vehiculo-grupo-titulo', ':focus-visible']) {
  check(`CSS contiene ${regla}`, html.includes(regla), regla);
}

// --- 3. selector.ts: API y tarjetas desde el catálogo ---
check('exporta createVehicleSelector', /export function createVehicleSelector/.test(selectorSrc), 'createVehicleSelector');
for (const metodo of ['setCurrent', 'toggle', 'isOpen']) {
  check(`API incluye ${metodo}`, new RegExp(`\\b${metodo}\\b`).test(selectorSrc), metodo);
}
check('tarjetas construidas desde VEHICLE_CATALOG', /VEHICLE_CATALOG\.filter/.test(selectorSrc) && /for \(const grupo of CATEGORIAS\)/.test(selectorSrc), 'grupos desde VEHICLE_CATALOG');
check('sin miniaturas falsas', !/<img/.test(selectorSrc), 'sin <img en selector.ts');
check('foco gestionado (abrir/cerrar)', /activeElement/.test(selectorSrc) && /canvas\.focus/.test(selectorSrc), 'foco a tarjeta y vuelta al canvas');
check('Escape cierra el panel', /'Escape'/.test(selectorSrc), 'Escape');

// --- 4. main.ts: cableado ---
check('KeyV conmuta el selector', /event\.code === 'KeyV'/.test(mainSrc) && /selectorVehiculo\?\.toggle\(\)/.test(mainSrc), 'keydown KeyV → toggle');
check('UI y API comparten cambiarVehiculo', /onSelect: \(id\) => \{\s*\n?\s*if \(cambiarVehiculo\(id\)\)/.test(mainSrc) && /setPreset: \(id: string\) => cambiarVehiculo\(id\)/.test(mainSrc), 'onSelect + setPreset → cambiarVehiculo');
check('persist mantiene chip y tarjeta', /selectorVehiculo\?\.setCurrent\(id\)/.test(mainSrc), 'persist → setCurrent');
check('botón táctil V con click directo', /#mobile-controls \[data-code="KeyV"\]/.test(mainSrc), 'querySelector KeyV + click');
for (const ayuda of ['TECLAS_CONDUCIENDO', 'TECLAS_A_PIE', 'CONTROLES_LIBRE']) {
  check(`${ayuda} menciona V`, new RegExp(`${ayuda}[\\s\\S]{0,400}V[^a-z]`).test(mainSrc), ayuda);
}

// --- 5. catálogo: 8 ids únicos en 3 categorías ---
const bundle = await build({
  entryPoints: [resolve(root, 'src/vehicle/catalog.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
});
const catalog = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);
const definitions = catalog.VEHICLE_CATALOG;
const ids = definitions.map((definition) => definition.id);
check('8 vehículos en el catálogo', definitions.length === 8, `${definitions.length}: ${ids.join(', ')}`);
check('ids únicos', new Set(ids).size === ids.length, ids.join(', '));
const counts = definitions.reduce((acc, definition) => {
  acc[definition.category] = (acc[definition.category] ?? 0) + 1;
  return acc;
}, {});
check('3 grupos: 4 todoterrenos, 2 coches, 2 motos', JSON.stringify(counts) === JSON.stringify({ todoterreno: 4, coche: 2, moto: 2 }), JSON.stringify(counts));
check('default estandar presente', ids.includes(catalog.DEFAULT_VEHICLE_ID), catalog.DEFAULT_VEHICLE_ID);

if (failures.length > 0) {
  console.error(`\nFALLARON ${failures.length} checks:\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log('\nTODO OK');