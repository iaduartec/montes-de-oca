// Validador de la capa de agua (plan AGUA, Tareas 2 y 3).
//
// Comprueba los invariantes de `public/water/water.json` derivado por
// `scripts/water/build_water.py` desde el crudo OSM de la Tarea 1 y el DEM:
// esquema y trazabilidad, láminas trianguladas, grilla de profundidad y,
// desde la Tarea 3, cintas de río/arroyo (`ribbons`), el vado del Oca sobre
// la ruta y el muro completo (`dam`). No crear un segundo validador.
//
// Uso: node scripts/water/validate_water.mjs
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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

const water = JSON.parse(readFileSync(resolve(root, 'public/water/water.json'), 'utf8'));
const stats = JSON.parse(readFileSync(resolve(root, 'public/water/stats.json'), 'utf8'));
const manifest = JSON.parse(
  readFileSync(resolve(root, 'data/water/raw/osm_water_window_manifest.json'), 'utf8'),
);

// ------------------------------------------------------------- geometría 2D
// Réplicas mínimas de los helpers de build_water.py (stdlib en ambos lados).
function polygonArea(ring) {
  let s = 0;
  for (let i = 0; i < ring.length; i++) {
    const [ax, az] = ring[i];
    const [bx, bz] = ring[(i + 1) % ring.length];
    s += ax * bz - bx * az;
  }
  return Math.abs(s) / 2;
}

function trianglesArea(ring, indices) {
  let total = 0;
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const [ax, az] = ring[indices[t]];
    const [bx, bz] = ring[indices[t + 1]];
    const [cx, cz] = ring[indices[t + 2]];
    total += Math.abs((bx - ax) * (cz - az) - (cx - ax) * (bz - az)) / 2;
  }
  return total;
}

function segDist(px, pz, ax, az, bx, bz) {
  const dx = bx - ax;
  const dz = bz - az;
  if (dx === 0 && dz === 0) return Math.hypot(px - ax, pz - az);
  const t = Math.min(1, Math.max(0, ((px - ax) * dx + (pz - az) * dz) / (dx * dx + dz * dz)));
  return Math.hypot(px - (ax + t * dx), pz - (az + t * dz));
}

function pointInPolygon(x, z, ring) {
  let inside = false;
  for (let i = 0; i < ring.length; i++) {
    const [x1, z1] = ring[i];
    const [x2, z2] = ring[(i + 1) % ring.length];
    if (segDist(x, z, x1, z1, x2, z2) < 1e-9) return true;
    if (z1 > z !== z2 > z) {
      if (x1 + ((z - z1) * (x2 - x1)) / (z2 - z1) > x) inside = !inside;
    }
  }
  return inside;
}

// ---------------------------------------------------------------- 1. esquema
console.log('=== 1. esquema y trazabilidad ===');
check('schemaVersion 1', water.schemaVersion === 1, `${water.schemaVersion}`);
for (const k of ['meta', 'levelM', 'sheets', 'ribbons', 'dam', 'depthGrid']) {
  check(`clave ${k} presente`, water[k] !== undefined && water[k] !== null);
}
check('meta.generadoPor es build_water.py',
  water.meta?.generadoPor === 'scripts/water/build_water.py', `${water.meta?.generadoPor}`);
check('meta.sourceSha256 coincide con el manifiesto del crudo',
  water.meta?.sourceSha256 === manifest.sha256,
  `water ${String(water.meta?.sourceSha256).slice(0, 12)} vs manifiesto ${String(manifest.sha256).slice(0, 12)}`);
check('stats.levelM coincide con water.levelM', stats.levelM === water.levelM,
  `stats ${stats.levelM} vs water ${water.levelM}`);

// Trazabilidad del anillo del embalse: debe salir del crudo versionado, no de un
// literal pegado en el constructor. Se verifica el sha256 del crudo contra su
// manifiesto y se reproyecta lon/lat -> mundo para compararlo con la lámina.
const ringRawBytes = readFileSync(resolve(root, 'data/water/raw/osm_reservoir_alba_ring.json'));
const ringRaw = JSON.parse(ringRawBytes.toString('utf8'));
const ringManifest = JSON.parse(
  readFileSync(resolve(root, 'data/water/raw/osm_reservoir_alba_ring_manifest.json'), 'utf8'),
);
const terrainCfg = JSON.parse(readFileSync(resolve(root, 'public/terrain/config.json'), 'utf8'));
check('sha256 del crudo del anillo coincide con su manifiesto',
  createHash('sha256').update(ringRawBytes).digest('hex') === ringManifest.sha256,
  `${String(ringManifest.sha256).slice(0, 12)}… (${ringManifest.members} ways, ${ringManifest.nodes} nodos)`);
const ringFromRaw = ringRaw.ring.map(([lon, lat]) => [
  (lon - terrainCfg.origin.lon) * terrainCfg.projection.metersPerDegreeLon,
  (lat - terrainCfg.origin.lat) * terrainCfg.projection.metersPerDegreeLat,
]);
const reservoirSheet = water.sheets.find((s) => s.id === 'embalse-alba');
check('el anillo del embalse sale del crudo versionado (mismo orden, <5 cm)',
  Boolean(reservoirSheet) && reservoirSheet.ring.length === ringFromRaw.length &&
    reservoirSheet.ring.every((p, i) => Math.hypot(p[0] - ringFromRaw[i][0], p[1] - ringFromRaw[i][1]) < 0.05),
  reservoirSheet
    ? `${reservoirSheet.ring.length} puntos vs crudo ${ringFromRaw.length}`
    : 'sin lámina embalse-alba');

// ---------------------------------------------------------------- 2. láminas
console.log('\n=== 2. láminas trianguladas ===');
check('hay al menos la lámina del embalse', water.sheets.length >= 1, `${water.sheets.length}`);
check('láminas con anillo e índices coherentes',
  water.sheets.every((s) => s.ring.length >= 3 && s.indices.length % 3 === 0 && s.indices.length >= 3));
check('índices dentro del anillo',
  water.sheets.every((s) => s.indices.every((ix) => Number.isInteger(ix) && ix >= 0 && ix < s.ring.length)));
check('láminas dentro de la ventana [0, 6000] (±0,5 m)',
  water.sheets.every((s) => s.ring.every(([x, z]) => x >= -0.5 && x <= 6000.5 && z >= -0.5 && z <= 6000.5)));

// ------------------------------------------------- 3. área de triangulación
// Invariante del constructor: ear clipping conserva el área del polígono.
// Se exige por lámina (no solo el embalse) y se cuenta cuántas se compararon
// para que el check no pueda pasar en vacío.
console.log('\n=== 3. área de triángulos vs área del polígono (< 0,5 %) ===');
let compared = 0;
let worst = 0;
let worstId = '';
for (const s of water.sheets) {
  const poly = polygonArea(s.ring);
  if (!(poly > 0)) {
    check(`área ${s.id}: polígono degenerado`, false, `área ${poly}`);
    continue;
  }
  const tris = trianglesArea(s.ring, s.indices);
  const err = Math.abs(tris - poly) / poly;
  compared++;
  if (err > worst) { worst = err; worstId = s.id; }
}
check(`áreas comparadas en ${compared} láminas (no vacío)`, compared === water.sheets.length, `${compared}`);
check('error relativo de área < 0,5 % en todas', worst < 0.005,
  `peor ${worstId} ${(worst * 100).toFixed(3)} %`);

// ------------------------------------------------------------ 4. grilla
console.log('\n=== 4. grilla de profundidad ===');
const g = water.depthGrid;
check('dimensiones coherentes (depthsDm = cols × rows)',
  g.depthsDm.length === g.cols * g.rows, `${g.cols}x${g.rows} = ${g.depthsDm.length}`);
check('profundidades enteras en rango 0..200 dm (0..20 m)',
  g.depthsDm.every((d) => Number.isInteger(d) && d >= 0 && d <= 200),
  `máx ${Math.max(...g.depthsDm)} dm`);
check('grilla a la cota del vaso', g.levelM === water.levelM, `grilla ${g.levelM} vs vaso ${water.levelM}`);

// --------------------------------------- 5. fondo junto a la presa, orilla 0
// Umbrales medidos, no inventados: el constructor da como máximo 18 m solo
// donde coinciden interior profundo y cercanía a la presa; en el vaso real
// el fondo más hondo queda a ~180 m del muro con 8,3 m (83 dm). Se fija el
// suelo en > 5 m para que una regresión del factor presa lo rompa, y se exige
// que la celda más honda esté del lado de la presa (< 250 m del segmento).
console.log('\n=== 5. fondo hondo junto a la presa y 0 en la orilla ===');
const embalse = water.sheets.find((s) => s.kind === 'reservoir') ?? water.sheets[0];
const [dax, daz] = water.dam.a;
const [dbx, dbz] = water.dam.b;
let minInside = Infinity;
let maxInside = -Infinity;
let maxAt = null;
for (let r = 0; r < g.rows; r++) {
  for (let c = 0; c < g.cols; c++) {
    const x = g.originX + c * g.cellM;
    const z = g.originZ + r * g.cellM;
    if (!pointInPolygon(x, z, embalse.ring)) continue;
    const v = g.depthsDm[r * g.cols + c];
    if (v < minInside) minInside = v;
    if (v > maxInside) { maxInside = v; maxAt = [x, z]; }
  }
}
check('hay celdas interiores (check no vacío)', maxAt !== null, maxAt ? `máx en ${maxAt}` : '');
const damDistMax = maxAt ? segDist(maxAt[0], maxAt[1], dax, daz, dbx, dbz) : Infinity;
check('mínimo interior 0 dm (orilla mojada)', minInside === 0, `mín ${minInside} dm`);
check('máximo interior > 50 dm (5 m de vaso)', maxInside > 50, `máx ${maxInside} dm`);
check('la celda más honda está del lado de la presa (< 250 m del muro)', damDistMax < 250,
  `${damDistMax.toFixed(1)} m`);

// ------------------------------------------------------------------ 6. presa
console.log('\n=== 6. muro de la presa ===');
check('coronación por encima del vaso (+0,6 m)', water.dam.crestM > water.levelM,
  `coronación ${water.dam.crestM} vs vaso ${water.levelM}`);
check('base por debajo de la coronación', water.dam.baseM < water.dam.crestM,
  `base ${water.dam.baseM}`);
check('extremos dentro de la ventana', [water.dam.a, water.dam.b]
  .every(([x, z]) => x >= 0 && x <= 6000 && z >= 0 && z <= 6000),
  `a ${water.dam.a} b ${water.dam.b}`);
check('ancho positivo', water.dam.widthM > 0, `${water.dam.widthM} m`);

// --------------------------------- 7. cota sobre el terreno (AGUA.md §6)
// Invariante: cota de lámina ≥ nivel del terreno debajo, para cada celda con
// profundidad > 0. Se lee el DEM de los tiles (mismo esquema
// `grid{x0,z0,dx,dz,columns,rows,heights}` que usa el constructor, indexado
// por celda de 1000 m, vecino más cercano) y se exige terreno ≤ cota + 1 mm.
// El check no puede pasar en vacío: exige haber comprobado > 100 celdas
// mojadas y publica el máximo de terreno medido en el detalle.
console.log('\n=== 7. cota de lámina ≥ terreno bajo celdas mojadas ===');
const tileGrids = readdirSync(resolve(root, 'public/terrain/tiles'))
  .filter((f) => /^tile_.*\.json$/.test(f))
  .sort()
  .map((f) => JSON.parse(readFileSync(resolve(root, 'public/terrain/tiles', f), 'utf8')).grid);
const tileIndex = new Map();
for (const t of tileGrids) {
  const x1 = t.x0 + (t.columns - 1) * t.dx;
  const z1 = t.z0 + (t.rows - 1) * t.dz;
  for (let ix = Math.floor((t.x0 - 1) / 1000); ix <= Math.floor((x1 + 1) / 1000); ix++) {
    for (let iz = Math.floor((t.z0 - 1) / 1000); iz <= Math.floor((z1 + 1) / 1000); iz++) {
      const k = ix + ',' + iz;
      if (!tileIndex.has(k)) tileIndex.set(k, []);
      tileIndex.get(k).push(t);
    }
  }
}
function heightAt(x, z) {
  const cands = tileIndex.get(Math.floor(x / 1000) + ',' + Math.floor(z / 1000)) ?? [];
  for (const t of cands) {
    if (x >= t.x0 - 0.01 && x <= t.x0 + (t.columns - 1) * t.dx + 0.01 &&
        z >= t.z0 - 0.01 && z <= t.z0 + (t.rows - 1) * t.dz + 0.01) {
      return t.heights[Math.round((z - t.z0) / t.dz) * t.columns + Math.round((x - t.x0) / t.dx)];
    }
  }
  return null;
}
let mojadas = 0;
let sobreTerreno = 0;
let sinDEM = 0;
let maxTerreno = -Infinity;
let maxTerrenoEn = null;
for (let r = 0; r < g.rows; r++) {
  for (let c = 0; c < g.cols; c++) {
    if (g.depthsDm[r * g.cols + c] <= 0) continue;
    const x = g.originX + c * g.cellM;
    const z = g.originZ + r * g.cellM;
    const h = heightAt(x, z);
    if (h === null) { sinDEM++; continue; }
    mojadas++;
    if (h > maxTerreno) { maxTerreno = h; maxTerrenoEn = [x, z]; }
    if (h > g.levelM + 0.001) sobreTerreno++;
  }
}
check('cota ≥ terreno debajo en celdas mojadas (> 100 comprobadas, no vacío)',
  mojadas > 100 && sinDEM === 0 && sobreTerreno === 0,
  `${mojadas} celdas mojadas, máx terreno ${maxTerreno} m en ${maxTerrenoEn} vs cota ${g.levelM}, ${sinDEM} sin DEM, ${sobreTerreno} por encima`);

// ------------------------------------------------------- 8. cintas de agua
// Invariantes del constructor (Tarea 3): una cinta por way río/arroyo/zanja
// no entubado, eje remuestreado a 2,5 m recortado a la ventana, ancho y
// calado según tipo. Los conteos no pueden pasar en vacío: se exige el total
// mínimo y más de 1000 puntos de eje comprobados.
console.log('\n=== 8. cintas de ríos y arroyos ===');
const porTipo = { river: 0, stream: 0, ditch: 0 };
for (const r of water.ribbons) porTipo[r.kind] = (porTipo[r.kind] ?? 0) + 1;
check('al menos 60 cintas de río/arroyo',
  water.ribbons.length >= 60,
  `${water.ribbons.length} (ríos ${porTipo.river ?? 0}, arroyos ${porTipo.stream ?? 0}, zanjas ${porTipo.ditch ?? 0})`);
check('cintas con ancho > 0, al menos 2 puntos de eje y calado > 0',
  water.ribbons.length > 0 && water.ribbons.every((r) =>
    r.widthM > 0 && r.points.length >= 2 && r.caladoM > 0));
const CALADO = { river: 0.25, stream: 0.18, ditch: 0.15 };
check('calado según tipo (river 0,25 / stream 0,18 / ditch 0,15, dentro del rango 0,15-0,25)',
  water.ribbons.length > 0 && water.ribbons.every((r) => r.caladoM === CALADO[r.kind]));
let puntosEje = 0;
let puntosEjeMal = 0;
for (const r of water.ribbons) {
  for (const p of r.points) {
    puntosEje++;
    if (!(Array.isArray(p) && p.length === 3 && p.every(Number.isFinite))) { puntosEjeMal++; continue; }
    if (p[0] < -0.5 || p[0] > 6000.5 || p[1] < -0.5 || p[1] > 6000.5) puntosEjeMal++;
  }
}
check('ejes recortados a la ventana [0, 6000] con cota finita (> 1000 puntos, no vacío)',
  puntosEje > 1000 && puntosEjeMal === 0, `${puntosEje} puntos, ${puntosEjeMal} mal`);

// ------------------------------------------------------- 9. vado del Oca
// Punto crítico de misión: donde la ruta vadea el Oca (mundo ≈ (3174, 3450))
// el calado medido (superficie − terreno) debe ser ≤ 0,35 m. Se exige desde
// `stats.crucesRuta` y se re-deriva de forma independiente: superficie =
// cota del eje + calado del tipo en el punto del eje más cercano, menos el
// terreno DEM bajo el cruce (tolerancia 0,05 m por el redondeo a cm).
console.log('\n=== 9. vado del Oca sobre la ruta (calado ≤ 0,35 m) ===');
const cruces = stats.crucesRuta ?? [];
const crucesRio = cruces.filter((c) => c.kind === 'river');
check('el Oca cruza la ruta (al menos 1 cruce de río en stats.crucesRuta)',
  crucesRio.length >= 1, `${crucesRio.length} de río sobre ${cruces.length} cruces`);
const maxCalado = cruces.length ? Math.max(...cruces.map((c) => c.caladoM)) : Infinity;
check('calado ≤ 0,35 m en TODOS los cruces de la ruta (río y arroyo)',
  cruces.length >= 1 && cruces.every((c) => c.caladoM <= 0.35),
  `máx ${maxCalado} m en ${cruces.map((c) => `(${c.x}, ${c.z}) ${c.kind}`).join(' ')}`);
let crucesVerificados = 0;
let peorDesvio = 0;
for (const c of cruces) {
  if (!Number.isFinite(c.x) || !Number.isFinite(c.caladoM)) continue;
  let mejor = null;
  for (const r of water.ribbons.filter((r) => r.kind === c.kind)) {
    for (let i = 0; i + 1 < r.points.length; i++) {
      const [ax, az, ay] = r.points[i];
      const [bx, bz, by] = r.points[i + 1];
      const d = segDist(c.x, c.z, ax, az, bx, bz);
      if (mejor === null || d < mejor.d) {
        const dx = bx - ax; const dz = bz - az;
        const t = dx === 0 && dz === 0 ? 0 :
          Math.min(1, Math.max(0, ((c.x - ax) * dx + (c.z - az) * dz) / (dx * dx + dz * dz)));
        mejor = { d, superficie: ay + t * (by - ay) + r.caladoM };
      }
    }
  }
  const terreno = surfaceAt(c.x, c.z);
  if (mejor === null || terreno === null) continue;
  const desvio = Math.abs((mejor.superficie - terreno) - c.caladoM);
  crucesVerificados++;
  if (desvio > peorDesvio) peorDesvio = desvio;
}
check('calado re-derivado del DEM coincide (±0,05 m, no vacío)',
  crucesVerificados === cruces.length && crucesVerificados >= 1 && peorDesvio <= 0.05,
  `${crucesVerificados}/${cruces.length} cruces, peor desvío ${peorDesvio.toFixed(3)} m`);

// ------------------------------------------------------- 10. trazabilidad
// Cada cinta debe salir de un way river/stream/ditch del crudo no entubado,
// y cada way dibujable debe aparecer en el detalle de stats (o como
// descartado con motivo). El muro debe salir del way waterway=dam.
console.log('\n=== 10. trazabilidad cintas ↔ crudo OSM ===');
const rawWater = JSON.parse(readFileSync(resolve(root, 'data/water/raw/osm_water_window.json'), 'utf8'));
const waysAgua = rawWater.elements.filter((e) =>
  e.type === 'way' && ['river', 'stream', 'ditch'].includes(e.tags?.waterway));
const dibujables = waysAgua.filter((e) => e.tags?.tunnel === undefined && e.tags?.culvert === undefined);
const entubados = waysAgua.filter((e) => e.tags?.tunnel !== undefined || e.tags?.culvert !== undefined);
const detalle = stats.cintas?.detalle ?? [];
check('stats.cintas.total coincide con water.ribbons',
  stats.cintas?.total === water.ribbons.length, `${stats.cintas?.total} vs ${water.ribbons.length}`);
const idsDibujables = new Set(dibujables.map((e) => `waterway-${e.id}`));
const idsDetalle = new Set(detalle.map((d) => d.osmId));
const descartadas = stats.cintasDescartadas ?? [];
const idsDescartadas = new Set(descartadas.map((d) => d.id ?? d.osmId));
const idsCubiertos = new Set([...idsDetalle, ...idsDescartadas]);
check('cada way dibujable queda cubierto por el detalle o por los descartados (ids únicos, robusto a tramos)',
  idsCubiertos.size === idsDibujables.size && [...idsDibujables].every((id) => idsCubiertos.has(id)) &&
    (stats.cintasEntubadas?.total ?? -1) === entubados.length,
  `${idsDetalle.size} ways en ${detalle.length} tramos + ${idsDescartadas.size} descartados = ${idsDibujables.size} dibujables; ${stats.cintasEntubadas?.total} entubadas de ${entubados.length}`);
check('cada cinta detalla un way dibujable real (no wastewater/dam/túnel)',
  detalle.length === water.ribbons.length && detalle.every((d) => idsDibujables.has(d.osmId)),
  `${detalle.length} detalles`);
const damRaw = rawWater.elements.find((e) => e.type === 'way' && e.tags?.waterway === 'dam');
const damPts = damRaw.geometry.map((pt) => [
  (pt.lon - terrainCfg.origin.lon) * terrainCfg.projection.metersPerDegreeLon,
  (pt.lat - terrainCfg.origin.lat) * terrainCfg.projection.metersPerDegreeLat,
]);
check('el muro sale del way waterway=dam del crudo (<5 cm en extremos)',
  Math.hypot(water.dam.a[0] - damPts[0][0], water.dam.a[1] - damPts[0][1]) < 0.05 &&
    Math.hypot(water.dam.b[0] - damPts[damPts.length - 1][0], water.dam.b[1] - damPts[damPts.length - 1][1]) < 0.05,
  `way ${damRaw.id} (${damPts.length} nodos)`);

// ------------------------------------- 11. cinta sobre el terreno (todo el eje)
// Invariante de la corrección de la Tarea 3: la superficie de la cinta (lerp
// del eje + calado) no puede quedar bajo el terreno triangular en NINGÚN
// punto del eje, no sólo en los vértices. Se muestrea a 0,25 m y en todos los
// cruces de frontera de triángulo del DEM: dentro de un triángulo ambas
// funciones son lineales, así que en los extremos de cada pieza está el
// control exacto. No puede pasar en vacío.
console.log('\n=== 11. superficie de cinta ≥ terreno + 0,02 m en todo el eje ===');
function surfaceAt(x, z) {
  const cands = tileIndex.get(Math.floor(x / 1000) + ',' + Math.floor(z / 1000)) ?? [];
  for (const t of cands) {
    if (x >= t.x0 - 0.01 && x <= t.x0 + (t.columns - 1) * t.dx + 0.01 &&
        z >= t.z0 - 0.01 && z <= t.z0 + (t.rows - 1) * t.dz + 0.01) {
      const c = (x - t.x0) / t.dx;
      const r = (z - t.z0) / t.dz;
      const i = Math.max(0, Math.min(Math.floor(c), t.columns - 2));
      const j = Math.max(0, Math.min(Math.floor(r), t.rows - 2));
      const u = c - i;
      const v = r - j;
      const hSW = t.heights[j * t.columns + i];
      const hSE = t.heights[j * t.columns + i + 1];
      const hNW = t.heights[(j + 1) * t.columns + i];
      const hNE = t.heights[(j + 1) * t.columns + i + 1];
      return u >= v
        ? hSW * (1 - u) + hSE * (u - v) + hNE * v
        : hSW * (1 - v) + hNE * u + hNW * (v - u);
    }
  }
  return null;
}
function triangleSplits(ax, az, bx, bz, dx, dz) {
  const ts = [];
  const add = (t) => { if (t > 1e-9 && t < 1 - 1e-9) ts.push(t); };
  if (bx !== ax) {
    for (let k = Math.ceil(Math.min(ax, bx) / dx - 1e-12);
         k <= Math.floor(Math.max(ax, bx) / dx + 1e-12); k++) {
      add((k * dx - ax) / (bx - ax));
    }
  }
  if (bz !== az) {
    for (let k = Math.ceil(Math.min(az, bz) / dz - 1e-12);
         k <= Math.floor(Math.max(az, bz) / dz + 1e-12); k++) {
      add((k * dz - az) / (bz - az));
    }
  }
  const f0 = ax / dx - az / dz;
  const f1 = bx / dx - bz / dz;
  if (Math.abs(f1 - f0) > 1e-12) {
    for (let k = Math.ceil(Math.min(f0, f1) - 1e-12);
         k <= Math.floor(Math.max(f0, f1) + 1e-12); k++) {
      add((k - f0) / (f1 - f0));
    }
  }
  ts.sort((a, b) => a - b);
  const out = [];
  for (const t of ts) if (!out.length || t - out[out.length - 1] > 1e-9) out.push(t);
  return out;
}
const dxDEM = tileGrids[0].dx;
const dzDEM = tileGrids[0].dz;
const holguraMin = { river: Infinity, stream: Infinity, ditch: Infinity };
let muestrasCinta = 0;
let cintasSinDEM = 0;
for (const r of water.ribbons) {
  for (let i = 0; i + 1 < r.points.length; i++) {
    const [ax, az, ay] = r.points[i];
    const [bx, bz, by] = r.points[i + 1];
    const pasos = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / 0.25));
    const ts = new Set([0, 1]);
    for (let j = 0; j <= pasos; j++) ts.add(j / pasos);
    for (const t of triangleSplits(ax, az, bx, bz, dxDEM, dzDEM)) ts.add(t);
    for (const t of ts) {
      const x = ax + (bx - ax) * t;
      const z = az + (bz - az) * t;
      const h = surfaceAt(x, z);
      if (h === null) { cintasSinDEM++; continue; }
      const holg = ay + t * (by - ay) + r.caladoM - h;
      muestrasCinta++;
      if (holg < holguraMin[r.kind]) holguraMin[r.kind] = holg;
    }
  }
}
let peorHolgura = Infinity;
for (const v of Object.values(holguraMin)) if (v < peorHolgura) peorHolgura = v;
check('superficie de cinta ≥ terreno + 0,02 m en todo el eje (> 10 000 muestras, no vacío)',
  muestrasCinta > 10000 && cintasSinDEM === 0 && peorHolgura >= 0.02 - 1e-4,
  `${muestrasCinta} muestras, peor holgura ${peorHolgura.toFixed(4)} m (` +
    Object.entries(holguraMin).map(([k, v]) => `${k} ${v.toFixed(4)}`).join(', ') +
    `), ${cintasSinDEM} sin DEM`);

// ------------------------------------------------------------------ resumen
const total = pass + fails.length;
console.log(`\n${pass}/${total} checks OK`);
if (fails.length) {
  console.log('FALLARON:');
  for (const f of fails) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('TODO OK');
