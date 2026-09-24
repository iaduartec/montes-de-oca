// Validador del terreno (FASE 2). Verifica que los tiles que se ENVIAN cumplen
// el presupuesto declarado en `public/terrain/budget.json`, y protege dos
// invariantes que descubrimos midiendo y que un cambio silencioso romperia.
//
// Por que existe: `budget.json` era una AFIRMACION sin validador. Nadie
// recomprobaba los totales, ni las costuras entre tiles, ni la interpolacion.
//
// Por que NO reusa los validadores de la referencia:
//   /home/kiri_/projects/montes-de-oca/src/city-ground-relief.ts:74
//     ... tiles.length > 100 || manifest.budgets.triangles > 200000 ... throw
//   /home/kiri_/projects/montes-de-oca/src/city-mountains.ts:20
//     ... manifest.budgets.triangles > 260000 || manifest.tiles.length > 180 || columns*rows > 600000 ... throw
// Nuestro terreno real son 2.880.000 triangulos en 36 tiles: **falla los dos**.
// Y no esta mal que fallen: esos numeros presupuestan UNA CAPA de una escena
// urbana de Shenzhen (parque / montanas decorativas sobre un terreno base
// grueso), no el terreno real completo de 6x6 km a 5 m. Copiarlos seria
// adoptar el presupuesto de otro juego. El nuestro esta medido y vive en
// budget.json; aca se re-deriva y se compara.
//
// Uso: node scripts/terrain/validate_terrain.mjs
import { readFileSync, readdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
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
// Un check NO puede pasar por no tener datos. Ese fue un error real: un
// validador imprimia solo los deltas, y un 0.0 se leia como "no comparo nada".
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

// ---------------------------------------------------------------- 1. config
const config = JSON.parse(readFileSync(resolve(root, 'public/terrain/config.json'), 'utf8'));
const budget = JSON.parse(readFileSync(resolve(root, 'public/terrain/budget.json'), 'utf8'));

console.log('=== 1. esquema declarado vs config ===');
check('config: sampling 5 m', config.bounds?.sampling === 5, `${config.bounds?.sampling}`);
check('config: verticalDatum 870', config.verticalDatum === 870, `${config.verticalDatum}`);
check('config: worldScale 1', config.worldScale === 1, `${config.worldScale}`);
check('budget: sampling coincide con config',
  budget.sampling_m === config.bounds?.sampling, `budget ${budget.sampling_m} vs config ${config.bounds?.sampling}`);
check('budget: tile_size 1000 m', budget.tile_size_m === 1000, `${budget.tile_size_m}`);
check('budget: 6x6 = 36 tiles', budget.tiles_por_lado === 6 && budget.tiles === 36,
  `${budget.tiles_por_lado}x${budget.tiles_por_lado} = ${budget.tiles}`);
check('budget: 201 nodos por tile', budget.nodos_por_tile === 201, `${budget.nodos_por_tile}`);
const spanE = (config.bounds?.e?.[1] ?? 0) - (config.bounds?.e?.[0] ?? 0);
const spanN = (config.bounds?.n?.[1] ?? 0) - (config.bounds?.n?.[0] ?? 0);
check('config: ventana 6000 x 6000 m', spanE === 6000 && spanN === 6000, `E ${spanE} m x N ${spanN} m`);

// ------------------------------------------------- 2. tiles y totales reales
console.log('\n=== 2. los tiles REALES vs el presupuesto declarado ===');
const dir = resolve(root, 'public/terrain/tiles');
const files = readdirSync(dir).filter((f) => /^tile_\d+_\d+\.json$/.test(f)).sort();
check('tiles: existen exactamente 36', files.length === 36, `${files.length}`);

const tiles = [];
let totVerts = 0;
let totTris = 0;
let totBytes = 0;
let demMin = Infinity;
let demMax = -Infinity;
const byId = new Map();
for (const f of files) {
  const raw = readFileSync(resolve(dir, f), 'utf8');
  const t = JSON.parse(raw);
  const g = t.grid;
  tiles.push({ t, g, bytes: Buffer.byteLength(raw, 'utf8') });
  byId.set(t.id, { t, g });
  totVerts += g.columns * g.rows;
  totTris += 2 * (g.columns - 1) * (g.rows - 1);
  totBytes += Buffer.byteLength(raw, 'utf8');
  for (const h of g.heights) if (h < demMin) demMin = h;
  for (const h of g.heights) if (h > demMax) demMax = h;
}
const all201 = tiles.every(({ g }) => g.columns === 201 && g.rows === 201);
const all5 = tiles.every(({ g }) => g.dx === 5 && g.dz === 5);
const allLen = tiles.every(({ g }) => g.heights.length === g.columns * g.rows);
const allLattice = tiles.every(({ g }) => g.x0 % 1000 === 0 && g.z0 % 1000 === 0
  && g.x0 / 1000 >= 0 && g.x0 / 1000 < 6 && g.z0 / 1000 >= 0 && g.z0 / 1000 < 6);
check('tiles: todos 201x201 nodos', all201);
check('tiles: todos dx = dz = 5 m', all5);
check('tiles: heights completo (columns*rows)', allLen);
check('tiles: todos en la reticula 6x6 de 1000 m', allLattice);
check('tiles: ids unicos y 36 distintos', new Set(tiles.map(({ t }) => t.id)).size === 36);
check('tiles: config lista exactamente los 36 que hay',
  config.tiles.map((x) => x.id).sort().join() === files.map((f) => f.replace('.json', '')).sort().join());

const pVerts = requireField(budget, 'totales.vertices', 'budget');
const pTris = requireField(budget, 'totales.triangulos', 'budget');
const pBytes = requireField(budget, 'totales.json_bytes', 'budget');
const pMib = requireField(budget, 'totales.json_mib', 'budget');
const pMesh = requireField(budget, 'totales.malla_runtime_mib', 'budget');
check('totales: vertices', totVerts === pVerts, `real ${totVerts} vs declarado ${pVerts}`);
check('totales: triangulos', totTris === pTris, `real ${totTris} vs declarado ${pTris}`);
check('totales: json_bytes', totBytes === pBytes, `real ${totBytes} vs declarado ${pBytes}`);
check('totales: json_mib', Math.abs(totBytes / 1024 / 1024 - pMib) < 0.01,
  `real ${(totBytes / 1024 / 1024).toFixed(2)} vs declarado ${pMib}`);

// bytes de la malla runtime, DERIVADOS del layout real de src/terrain.ts:130-132,167
//   positions 3*f32 + normals 3*f32 + colors 4*f32 + uvs 2*f32 = 48 B/vertice
//   indices u16 * 6 por celda
const BYTES_PER_VERT = (3 + 3 + 4 + 2) * 4;
let meshBytes = 0;
for (const { g } of tiles) {
  meshBytes += g.columns * g.rows * BYTES_PER_VERT + (g.columns - 1) * (g.rows - 1) * 6 * 2;
}
const meshMib = meshBytes / 1024 / 1024;
check('totales: malla_runtime_mib derivada del layout de vertices',
  Math.abs(meshMib - pMesh) < 0.01,
  `derivada ${meshMib.toFixed(2)} MiB (${BYTES_PER_VERT} B/vert + u16) vs declarada ${pMesh}`);

// ------------------------------------------------------ 3. rango del DEM
console.log('\n=== 3. rango del DEM y spans por tile ===');
check('DEM: cota minima 870 m', demMin === budget.dem?.min_m, `real ${demMin} vs declarado ${budget.dem?.min_m}`);
check('DEM: cota maxima 1194 m', demMax === budget.dem?.max_m, `real ${demMax} vs declarado ${budget.dem?.max_m}`);
let spanBad = 0;
for (const d of budget.detalle_tiles ?? []) {
  const g = byId.get(d.id)?.g;
  if (!g) { spanBad++; continue; }
  const lo = Math.min(...g.heights);
  const hi = Math.max(...g.heights);
  if (lo !== d.heights_span_m[0] || hi !== d.heights_span_m[1]) spanBad++;
}
check('tiles: heights_span declarado coincide con el real (36)',
  budget.detalle_tiles?.length === 36 && spanBad === 0, `${spanBad} discrepancias`);

// ------------------------------------------------------------ 4. costuras
// budget.json afirma `cruces_dem_tiles_diff_max_m: 0`. Se comprueba de verdad:
// los tiles vecinos comparten 201 nodos de borde y tienen que ser identicos.
console.log('\n=== 4. costuras entre tiles vecinos (validando diff_max = 0) ===');
let seamPairs = 0;
let seamWorst = 0;
let seamWorstAt = '';
for (let iz = 0; iz < 6; iz++) {
  for (let ix = 0; ix < 6; ix++) {
    const a = byId.get(`tile_${ix}_${iz}`);
    if (!a) continue;
    // borde ESTE de a contra borde OESTE de (ix+1, iz)
    if (ix + 1 < 6) {
      const b = byId.get(`tile_${ix + 1}_${iz}`);
      if (b) {
        seamPairs++;
        for (let r = 0; r < 201; r++) {
          const d = Math.abs(a.g.heights[r * 201 + 200] - b.g.heights[r * 201 + 0]);
          if (d > seamWorst) { seamWorst = d; seamWorstAt = `E ${a.t.id}/${b.t.id} fila ${r}`; }
        }
      }
    }
    // borde NORTE de a contra borde SUR de (ix, iz+1)
    if (iz + 1 < 6) {
      const b = byId.get(`tile_${ix}_${iz + 1}`);
      if (b) {
        seamPairs++;
        for (let c = 0; c < 201; c++) {
          const d = Math.abs(a.g.heights[200 * 201 + c] - b.g.heights[0 * 201 + c]);
          if (d > seamWorst) { seamWorst = d; seamWorstAt = `N ${a.t.id}/${b.t.id} col ${c}`; }
        }
      }
    }
  }
}
check('costuras: se compararon 60 pares de bordes', seamPairs === 60, `${seamPairs}`);
check('costuras: borde identico en los 60 pares (diff 0 m)',
  seamWorst === 0, seamWorst === 0 ? '0 m' : `max ${seamWorst} m en ${seamWorstAt}`);

// ------------------------------------------- 5. invariante de interpolacion
// LA TRAMPA: `heightAt` interpola sobre TRIANGULOS con diagonal SO->NE, que es
// exactamente la diagonal que usa la malla (src/terrain.ts:175-180 emite
// sw,ne,se / sw,nw,ne). Si alguien cambia la diagonal en un lado y no en el
// otro, las ruedas y todo lo apoyado quedan fuera de la superficie dibujada,
// SIN error de tipos y SIN fallar el build. Este check lo caza.
console.log('\n=== 5. invariante de interpolacion (diagonal SO->NE) ===');
// Se transpila el `heightfield` REAL del proyecto y se le pregunta. No se
// reimplementa la respuesta esperada: se compara contra las dos candidatas.
// El temporal va DENTRO del proyecto: desde /tmp no se resuelve @babylonjs/core.
const tmp = mkdtempSync(resolve(here, '.validate-tmp-'));
const gen = (rel, out) => {
  const text = ts.transpileModule(readFileSync(resolve(root, rel), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, verbatimModuleSyntax: false },
  }).outputText;
  writeFileSync(resolve(tmp, out), text
    .replace(/(['"])\.\/config\1/g, '$1./config.gen.mjs$1')
    .replace(/(['"])(@babylonjs\/core\/[^'"]+)\1/g, '$1$2.js$1'));
};
gen('src/config.ts', 'config.gen.mjs');
gen('src/heightfield.ts', 'heightfield.gen.mjs');
const { createHeightfield: hfFactory } = await import(`file://${resolve(tmp, 'heightfield.gen.mjs')}`);
rmSync(tmp, { recursive: true, force: true });

const tile33 = byId.get('tile_3_3');
const hf = hfFactory(tile33.g, config.worldScale);

function triAt(g, x, z) {
  const i = (x - g.x0) / g.dx;
  const j = (z - g.z0) / g.dz;
  const i0 = Math.min(Math.max(Math.floor(i), 0), g.columns - 2);
  const j0 = Math.min(Math.max(Math.floor(j), 0), g.rows - 2);
  const fx = i - i0;
  const fz = j - j0;
  const sw = g.heights[j0 * g.columns + i0];
  const se = g.heights[j0 * g.columns + i0 + 1];
  const nw = g.heights[(j0 + 1) * g.columns + i0];
  const ne = g.heights[(j0 + 1) * g.columns + i0 + 1];
  return fz <= fx ? sw + (se - sw) * fx + (ne - se) * fz : sw + (ne - nw) * fx + (nw - sw) * fz;
}
function bilAt(g, x, z) {
  const i = (x - g.x0) / g.dx;
  const j = (z - g.z0) / g.dz;
  const i0 = Math.min(Math.max(Math.floor(i), 0), g.columns - 2);
  const j0 = Math.min(Math.max(Math.floor(j), 0), g.rows - 2);
  const fx = i - i0;
  const fz = j - j0;
  const sw = g.heights[j0 * g.columns + i0];
  const se = g.heights[j0 * g.columns + i0 + 1];
  const nw = g.heights[(j0 + 1) * g.columns + i0];
  const ne = g.heights[(j0 + 1) * g.columns + i0 + 1];
  return (1 - fx) * (1 - fz) * sw + fx * (1 - fz) * se + (1 - fx) * fz * nw + fx * fz * ne;
}

let maxTriErr = 0;
let maxBilDiff = 0;
let distinguishable = 0;
let n = 0;
let seed = 12345;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
for (let k = 0; k < 5000; k++) {
  // OJO: hay que muestrear DENTRO de la celda del tile. tile_3_3 empieza en
  // (3000, 3000); muestrear [0,1000] cae fuera y todo da lo mismo -> check vacio.
  const x = tile33.g.x0 + rnd() * 1000;
  const z = tile33.g.z0 + rnd() * 1000;
  const app = hf.heightAt(x, z);
  const tri = triAt(tile33.g, x, z);
  const bil = bilAt(tile33.g, x, z);
  maxTriErr = Math.max(maxTriErr, Math.abs(app - tri));
  const d = Math.abs(tri - bil);
  maxBilDiff = Math.max(maxBilDiff, d);
  if (d > 0.01) distinguishable++;
  n++;
}
check('interpolacion: heightAt == plano triangular SO->NE (1e-9)',
  maxTriErr < 1e-9, `error max ${maxTriErr.toExponential(3)} m en ${n} muestras`);
check('interpolacion: distinguible de bilineal (si no, el check es vacio)',
  distinguishable > 0,
  `${distinguishable}/${n} muestras difieren mas de 0.01 m (max ${maxBilDiff.toFixed(4)} m)`);

// ------------------------------------------- 6. presupuesto en vista
console.log('\n=== 6. presupuesto en vista ===');
const r900 = (budget.en_vista_por_radio ?? []).find((r) => r.radio_m === budget.radio_vista_sugerido_m);
check('vista: hay entrada para el radio sugerido', Boolean(r900),
  `radio ${budget.radio_vista_sugerido_m} m`);
if (r900) {
  const perTile = 80000;
  const worst = r900.triangulos_frustum_max;
  check('vista: peor caso = tiles_frustum_max * 80000 tris',
    worst === r900.tiles_frustum_max * perTile,
    `${r900.tiles_frustum_max} tiles x ${perTile} = ${worst}`);
  check('vista: peor caso <= 320000 tris (4 tiles, medido en la app)',
    worst <= 320000, `${worst}`);
}
const medido = budget.medido_en_app?.capturas ?? [];
check('vista: hay capturas medidas en la app', medido.length > 0, `${medido.length}`);
let overBudget = 0;
for (const c of medido) {
  if (Number(c.triangulos_en_vista) > 320000) overBudget++;
}
check('vista: ninguna captura supera 320000 tris en vista', overBudget === 0, `${overBudget} por encima`);
check('vista: las capturas reportan 36 tiles', medido.every((c) => Number(c.tiles_totales) === 36));

// ------------------------------------------------------------------ resumen
const total = pass + fails.length;
console.log(`\n${pass}/${total} checks OK`);
if (fails.length) {
  console.log('FALLARON:');
  for (const f of fails) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('TODO OK');
