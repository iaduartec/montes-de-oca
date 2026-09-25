#!/usr/bin/env node
// Validador de la atmósfera (FASE I). Verifica SIN Babylon lo que se puede
// verificar sin Babylon:
//
//   1. que `follow()` / `sunPositionFor()` dejen al jugador SOBRE el eje de la
//      luz y a la distancia declarada, y que el peor corrimiento vertical del
//      mundo (Y ∈ [dem.min − datum, dem.max − datum]) quepa en SHADOW_RADIUS_M;
//   2. que la densidad de niebla elegida cumpla lo que PROMETE: visibilidad del
//      objetivo, caída en la esquina de la ventana y distancia al "horizonte".
//
// Patrón obligatorio de `scripts/terrain/validate_terrain.mjs`: se transpila el
// .ts REAL con `typescript` y se llama al módulo real. NO se reimplementa ni la
// geometría del sol ni la fórmula de niebla acá: todas las cuentas salen de
// funciones exportadas por `src/environment/atmosphere.ts`.
//
// Uso: node scripts/environment/verify_atmosphere.mjs
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');

let pass = 0;
const fails = [];
function check(name, ok, detail = '') {
  if (ok) {
    pass++;
    console.log(`[OK  ] ${name}${detail ? ' — ' + detail : ''}`);
  } else {
    fails.push(name);
    console.log(`[FALLA] ${name}${detail ? ' — ' + detail : ''}`);
  }
}
// Un check no puede pasar "por vacío".
function requireField(obj, path, ctx) {
  let cur = obj;
  for (const k of path.split('.')) {
    if (cur === null || cur === undefined || !(k in cur)) {
      check(`${ctx}: falta ${path}`, false, 'sin el dato no se puede validar');
      return undefined;
    }
    cur = cur[k];
  }
  return cur;
}
const close = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

// ------------------------------------------------------------------ módulos
// El temporal va DENTRO del proyecto: desde /tmp no se resuelve @babylonjs/core.
const tmp = mkdtempSync(resolve(here, '.verify-atmosphere-'));
function transpile(relPath, outName) {
  const text = ts.transpileModule(readFileSync(resolve(root, relPath), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, verbatimModuleSyntax: false },
  }).outputText;
  writeFileSync(
    resolve(tmp, outName),
    text.replace(/(['"])(@babylonjs\/core\/[^'"]+)\1/g, '$1$2.js$1').replace(/(['"])\.\/route-types\1/g, '$1./route-types.gen.mjs$1'),
  );
}
transpile('src/gameplay/route-types.ts', 'route-types.gen.mjs');
transpile('src/gameplay/first-route.ts', 'first-route.gen.mjs');
transpile('src/environment/atmosphere.ts', 'atmosphere.gen.mjs');

let atmosphere;
let FIRST_ROUTE;
try {
  atmosphere = await import(`file://${resolve(tmp, 'atmosphere.gen.mjs')}`);
  ({ FIRST_ROUTE } = await import(`file://${resolve(tmp, 'first-route.gen.mjs')}`));
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
const {
  createAtmosphere,
  sunPositionFor,
  shadowVerticalOffset,
  fogVisibilityAt,
  fogDistanceForVisibility,
  SUN_TO_SCENE,
  SUN_DISTANCE_M,
  SUN_ANCHOR_Y,
  SHADOW_RADIUS_M,
  SHADOW_MAP_SIZE,
  FOG_DENSITY,
  FOG_DENSITY_DENSE,
  FOG_HORIZON_VISIBILITY,
} = atmosphere;

console.log('=== 0. la API exportada existe ===');
check('createAtmosphere es función', typeof createAtmosphere === 'function');
for (const k of ['SUN_TO_SCENE', 'SUN_DISTANCE_M', 'SUN_ANCHOR_Y', 'SHADOW_RADIUS_M', 'SHADOW_MAP_SIZE', 'FOG_DENSITY', 'FOG_DENSITY_DENSE']) {
  check(`export ${k}`, atmosphere[k] !== undefined, `${atmosphere[k]}`);
}

// ------------------------------------------------------ 1. geometría del sol
console.log('\n=== 1. follow() mantiene al jugador sobre el eje y dentro del radio ===');
const budgets = JSON.parse(readFileSync(resolve(root, 'public/terrain/budget.json'), 'utf8'));
const config = JSON.parse(readFileSync(resolve(root, 'public/terrain/config.json'), 'utf8'));
const datum = config.verticalDatum * config.worldScale;
const demMinWorldY = requireField(budgets, 'dem.min_m', 'budget') - datum;
const demMaxWorldY = requireField(budgets, 'dem.max_m', 'budget') - datum;
check('demo: rango Y de mundo derivado del DEM y el datum',
  demMinWorldY === 0 && demMaxWorldY === 324, `Y ∈ [${demMinWorldY}, ${demMaxWorldY}]`);

// Muestras por todo el mundo, no sólo el origen: el offset debe ser CONSTANTE.
const samples = [
  [0, 0],
  [3000, 3000],
  [6000, 6000],
  [-500, 6500],
  [FIRST_ROUTE.start.x, FIRST_ROUTE.start.z],
  [FIRST_ROUTE.target.x, FIRST_ROUTE.target.z],
  [FIRST_ROUTE.returnPoint.x, FIRST_ROUTE.returnPoint.z],
  [1234.5, 4321.25],
];
let distanceOk = 0;
let axisOk = 0;
let aboveOk = 0;
const offsets = [];
for (const [x, z] of samples) {
  const p = sunPositionFor(x, z);
  // (a) el sol está a EXACTAMENTE SUN_DISTANCE_M del ancla (x, SUN_ANCHOR_Y, z).
  const d = Math.hypot(p.x - x, p.y - SUN_ANCHOR_Y, p.z - z);
  if (close(d, SUN_DISTANCE_M)) distanceOk++;
  // (b) el ancla cae sobre el eje de la vista: el vector (ancla − sol) es paralelo
  //     a la dirección de la luz (producto vectorial ~ 0).
  const ax = x - p.x;
  const ay = SUN_ANCHOR_Y - p.y;
  const az = z - p.z;
  const crossX = ay * SUN_TO_SCENE.z - az * SUN_TO_SCENE.y;
  const crossY = az * SUN_TO_SCENE.x - ax * SUN_TO_SCENE.z;
  const crossZ = ax * SUN_TO_SCENE.y - ay * SUN_TO_SCENE.x;
  if (Math.hypot(crossX, crossY, crossZ) < 1e-6) axisOk++;
  // (c) el sol nace por ENCIMA del ancla (elevación 60,3°: dirY = −0,869).
  if (p.y > SUN_ANCHOR_Y) aboveOk++;
  offsets.push({ dx: p.x - x, dy: p.y - SUN_ANCHOR_Y, dz: p.z - z });
}
check(`sol a ${SUN_DISTANCE_M} m del ancla en las ${samples.length} muestras`, distanceOk === samples.length, `${distanceOk}/${samples.length}`);
check(`ancla sobre el eje de la luz en las ${samples.length} muestras`, axisOk === samples.length, `${axisOk}/${samples.length}`);
check('el sol queda por encima del ancla en todas las muestras', aboveOk === samples.length, `${aboveOk}/${samples.length}`);

// El offset (sol − ancla) NO puede acumularse al llamar follow con posiciones nuevas.
const base = offsets[0];
const constant = offsets.every((o) => close(o.dx, base.dx, 1e-9) && close(o.dy, base.dy, 1e-9) && close(o.dz, base.dz, 1e-9));
check('el offset (sol − ancla) es constante: follow() no acumula deriva', constant,
  `offset base (${base.dx.toFixed(2)}, ${base.dy.toFixed(2)}, ${base.dz.toFixed(2)})`);

// El peor corrimiento vertical del mundo entero tiene que caber en el radio.
const worstVertical = Math.max(shadowVerticalOffset(demMinWorldY), shadowVerticalOffset(demMaxWorldY));
check(`peor corrimiento vertical ${worstVertical.toFixed(2)} m < radio ${SHADOW_RADIUS_M} m`,
  worstVertical < SHADOW_RADIUS_M,
  `ancla Y=${SUN_ANCHOR_Y} · factor ${Math.hypot(SUN_TO_SCENE.x, SUN_TO_SCENE.z).toFixed(4)}`);
check('mapa cuadrado de lado 2·radio (resolución declarada)',
  SHADOW_MAP_SIZE === 1024, `${SHADOW_MAP_SIZE}² → ${(2 * SHADOW_RADIUS_M / SHADOW_MAP_SIZE).toFixed(3)} m/téxel`);

// ------------------------------------------------------------- 2. la niebla
console.log('\n=== 2. la densidad de niebla cumple lo que promete ===');
// Roundtrip: la distancia al horizonte que declara `fogDistanceForVisibility` debe
// devolver, por la función REAL `fogVisibilityAt`, la visibilidad pedida.
let roundtripOk = 0;
let roundtripTotal = 0;
for (const density of [FOG_DENSITY, FOG_DENSITY_DENSE]) {
  for (const vis of [0.9, 0.5, 0.1, FOG_HORIZON_VISIBILITY]) {
    roundtripTotal++;
    const back = fogVisibilityAt(fogDistanceForVisibility(vis, density), density);
    if (close(back, vis, 1e-6)) roundtripOk++;
  }
}
check(`roundtrip niebla ↔ distancia en ${roundtripTotal} combinaciones`, roundtripOk === roundtripTotal, `${roundtripOk}/${roundtripTotal}`);

// Monotonía: más lejos ⇒ menos visible.
const monotonic = fogVisibilityAt(500) > fogVisibilityAt(1500)
  && fogVisibilityAt(1500) > fogVisibilityAt(3000) && fogVisibilityAt(3000) > fogVisibilityAt(6000);
check('la visibilidad cae con la distancia (monótona)', monotonic,
  `v(500)=${fogVisibilityAt(500).toFixed(3)} v(1500)=${fogVisibilityAt(1500).toFixed(3)} ` +
  `v(3000)=${fogVisibilityAt(3000).toFixed(3)} v(6000)=${fogVisibilityAt(6000).toFixed(3)}`);

// Promesa 1: el objetivo se ve. Distancia en planta spawn → repetidor.
const targetDistance = Math.hypot(FIRST_ROUTE.target.x - FIRST_ROUTE.start.x, FIRST_ROUTE.target.z - FIRST_ROUTE.start.z);
const targetVisibility = fogVisibilityAt(targetDistance);
check(`objetivo a ${targetDistance.toFixed(0)} m visible (${(targetVisibility * 100).toFixed(1)} % > 70 %)`,
  targetVisibility > 0.7, `densidad ${FOG_DENSITY}`);

// Promesa 2: la esquina de la ventana ya está desvaída (profundidad, no bruma).
const corner = 3000 * Math.SQRT2; // centro (3000,3000) → esquina de 6000×6000 m
const cornerVisibility = fogVisibilityAt(corner);
check(`esquina de la ventana (${corner.toFixed(0)} m) desvaída (${(cornerVisibility * 100).toFixed(1)} % < 35 %)`,
  cornerVisibility < 0.35, `densidad ${FOG_DENSITY}`);

// Promesa 3: el horizonte al 1 % cae FUERA de la ventana; la niebla no es un muro.
const horizon = fogDistanceForVisibility(FOG_HORIZON_VISIBILITY);
check(`horizonte al ${FOG_HORIZON_VISIBILITY * 100} % a ${horizon.toFixed(0)} m > 6000 m (fuera de la ventana)`,
  horizon > 6000, `medio tapado a ${fogDistanceForVisibility(0.5).toFixed(0)} m`);

// `dense` densifica de verdad.
const denseNarrower = fogVisibilityAt(1500, FOG_DENSITY_DENSE) < fogVisibilityAt(1500, FOG_DENSITY);
check('la variante densa tapa más a la misma distancia', denseNarrower,
  `normal ${fogVisibilityAt(1500, FOG_DENSITY).toFixed(3)} vs densa ${fogVisibilityAt(1500, FOG_DENSITY_DENSE).toFixed(3)}`);

// ------------------------------------------------------------------ resumen
const total = pass + fails.length;
console.log(`\n${pass}/${total} checks OK`);
if (fails.length) {
  console.log('FALLARON:');
  for (const f of fails) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('TODO OK');
