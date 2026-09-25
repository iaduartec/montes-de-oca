#!/usr/bin/env node
// Construye `public/vegetation/vegetation.json` desde landcover real de OSM.
//
// Por que existe: el terreno (IGN MDT05) y la red viaria (OSM) ya se ven bien,
// pero el mapa parece una maqueta topografica porque nada tapa el color de
// altura. Esta capa es la que lo hace bosque.
//
// Decisiones que NO son obvias:
//  1. LA ALTURA NO SE CALCULA ACA. Cada instancia guarda solo `x`/`z` (planta).
//     El `y` lo pide el runtime a `terrain.heightAt`. Dos fuentes de altura =
//     dos verdades = arboles flotando el dia que cambie el DEM.
//  2. EL DESPEJE (corredores + claros) pasa ACA, no en runtime: evaluar
//     ~40.000 punto-segmento por frame es plata tirada. Se resuelve una vez.
//  3. LA DENSIDAD CAE CON LA DISTANCIA A LA PRIMERA RUTA. La ventana mide
//     36 km² y el jugador recorre 2,4 km: llenar todo por igual gasta el 95 %
//     del presupuesto en cosas que nunca entran en pantalla.
//  4. GRILLA JITTEREADA GLOBAL + hash por celda (sin estado) = el mismo JSON
//     mañana, y el resultado NO depende del orden en que se recorran los
//     poligonos. Sin eso `--check` no podria re-derivar y comparar.
//
// Uso:
//   node scripts/environment/build_vegetation.mjs            # escribe el JSON
//   node scripts/environment/build_vegetation.mjs --check     # NO escribe
//
// El transpilado de los .ts del proyecto sigue el patron de
// `scripts/terrain/validate_terrain.mjs`: se le pregunta al heightfield REAL
// del repo (diagonal SO->NE incluida); reimplementar esa interpolacion esta
// prohibido porque da hasta 0,29 m de error contra la malla dibujada.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const CHECK = process.argv.includes('--check');

/** Semilla unica de la siembra. Cambiarla cambia TODO el JSON (por diseño). */
const SEED = 20260925;

/** Ventana del mundo en metros (convencion del repo: x = E−471500, z = N−4689000). */
const WINDOW = { minX: 0, maxX: 6000, minZ: 0, maxZ: 6000 };

/** Semiancho del corredor a despejar por clase de via (calzada + berma). */
const CORRIDOR_HALF_WIDTH = { ROAD: 12, TRACK: 8, PATH: 4 };

/** Radio libre alrededor del inicio (aparicion). El del objetivo sale de la ruta. */
const START_CLEAR_RADIUS_M = 30;

/**
 * Prioridad de densidad = max(min, 1/(1+(d/D)^2)). Suave a proposito: escalones
 * de densidad se ven desde el aire como una raya artificial en el bosque.
 *
 * El `min` es el piso del TAIL: 17,5 km² de bosque quedan a mas de 1000 m de
 * la ruta y `viewRadius` es 900. Con un piso de 0,06 esa cola se comia ~14.000
 * arboles que NUNCA entran en pantalla (5,8 MiB de JSON para nada). En 0,012
 * la cola sigue existiendo (el bosque lejano tapa el color de altura en la
 * vista aerea) pero cuesta ~2.000 instancias.
 * `grass-tufts` usa D chico y min 0: la hierba solo importa donde se puede
 * conducir, mas alla es un cuadro verde de un pixel.
 */
const PRIORITY = {
  'forest-trees': { d: 225, min: 0.01 },
  'field-trees': { d: 225, min: 0.015 },
  'grass-shrubs': { d: 225, min: 0.015 },
  'grass-tufts': { d: 150, min: 0 },
};

/**
 * Paso de la grilla de siembra = 1/√densidad de la clase.
 * Medido con la superficie real del landcover: 7,8 m entre ejes deja ~1 arbol
 * cada 66 m² en el tramo cercano (≈150/ha), que se ve como bosque cerrado sin
 * pasar de ~30.000 árboles en total.
 */
const SPACING = {
  'forest-trees': 7.8, // 1 arbol / ~61 m² de bosque
  'field-trees': 25.8, // 1 arbol aislado / ~667 m² de cultivo
  'grass-shrubs': 12.9, // 1 arbusto / ~166 m²
  'grass-tufts': 4.7, // 1 mata / ~22 m²
};

/** Resolución del campo de distancia a la ruta (alimenta prioridad y tier). */
const FIELD_STEP_M = 20;
/** Bandas del `tier`: prioridad de detalle con la camara sobre la ruta. */
const TIER_NEAR_M = 300;
const TIER_MID_M = 900;
/** El campo deja de importar mas alla de esta distancia: ya es todo piso. */
const FIELD_MAX_M = 2500;

// ------------------------------------------------------------------ utilidades
const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const r1 = (v) => Math.round(v * 10) / 10;
const r3 = (v) => Math.round(v * 1000) / 1000;

/**
 * Hash entero determinista SIN estado. Un PRNG secuencial por poligono haria
 * que el resultado dependa del orden de iteracion; con un hash por celda el
 * mismo punto recibe la misma tirada aunque otro poligono lo reclame antes.
 */
function hashRand(i, j, salt) {
  let h = Math.imul(i ^ 0x9e3779b9, 2654435761) ^ Math.imul(j + salt * 7919, 40503) ^ SEED;
  h = Math.imul(h ^ (h >>> 15), 2246822519);
  h = Math.imul(h ^ (h >>> 13), 3266489917);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Empaqueta un par de indices en un unico número (clave de Map/Set). */
const pairKey = (i, j) => i * 1000000 + j;

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

// ------------------------------------------- transpilar los .ts del proyecto
const tmp = mkdtempSync(resolve(here, '.veg-tmp-'));
function gen(rel, out) {
  let text = ts.transpileModule(readFileSync(resolve(root, rel), 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      verbatimModuleSyntax: false,
    },
  }).outputText;
  // El temporal vive dentro del proyecto para que Node resuelva @babylonjs/core.
  text = text
    .replace(/(['"])\.\/config\1/g, '$1./config.gen.mjs$1')
    .replace(/(['"])\.\/route-types\1/g, '$1./route-types.gen.mjs$1')
    .replace(/(['"])(@babylonjs\/core\/[^'"]+)\1/g, '$1$2.js$1');
  writeFileSync(resolve(tmp, out), text);
  return `file://${resolve(tmp, out)}`;
}
const { wgs84ToWorld } = await import(gen('src/config.ts', 'config.gen.mjs'));
const { containsPoint, createHeightfield, gridExtent } = await import(gen('src/heightfield.ts', 'heightfield.gen.mjs'));
gen('src/gameplay/route-types.ts', 'route-types.gen.mjs');
const { FIRST_ROUTE } = await import(gen('src/gameplay/first-route.ts', 'first-route.gen.mjs'));
rmSync(tmp, { recursive: true, force: true });

const config = JSON.parse(readFileSync(resolve(root, 'public/terrain/config.json'), 'utf8'));
const datum = config.verticalDatum * config.worldScale;
const SOURCE_FILE = resolve(root, 'data/gameplay/raw/osm_landcover_window.json');

// ------------------------------------------------------ geometría de corredores
function pointSegmentDistance(px, pz, ax, az, bx, bz) {
  const dx = bx - ax;
  const dz = bz - az;
  const len2 = dx * dx + dz * dz;
  let t = len2 > 0 ? ((px - ax) * dx + (pz - az) * dz) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const ex = ax + t * dx - px;
  const ez = az + t * dz - pz;
  return Math.sqrt(ex * ex + ez * ez);
}

/**
 * Parte la polilinea DENSA de la ruta en tramos por clase de vía.
 * NO se usa la lista de `waypoints`: estan cada ~150 m y la cuerda que unen se
 * despega del trazado real, lo que dejaria arboles encima de la calzada. El
 * corte sale de la distancia acumulada (`atM`) del punto donde cambia `leg`.
 */
function buildRouteCorridors(route) {
  const poly = route.polyline;
  const cum = [0];
  for (let i = 1; i < poly.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(poly[i].x - poly[i - 1].x, poly[i].z - poly[i - 1].z));
  }
  const total = cum[cum.length - 1];

  const pointAt = (d) => {
    if (d <= 0) return { x: poly[0].x, z: poly[0].z };
    if (d >= total) return { x: poly[poly.length - 1].x, z: poly[poly.length - 1].z };
    let k = 0;
    while (k < cum.length - 2 && cum[k + 1] < d) k++;
    const span = cum[k + 1] - cum[k];
    const t = span > 0 ? (d - cum[k]) / span : 0;
    return { x: poly[k].x + (poly[k + 1].x - poly[k].x) * t, z: poly[k].z + (poly[k + 1].z - poly[k].z) * t };
  };

  // Un corte por cada cambio de `leg`; el corte queda en el `atM` del ultimo
  // waypoint del tramo anterior (el de la bifurcacion).
  const cuts = [];
  for (let i = 1; i < route.waypoints.length; i++) {
    if (route.waypoints[i].leg !== route.waypoints[i - 1].leg) {
      cuts.push({ atM: route.waypoints[i - 1].atM, leg: route.waypoints[i].leg });
    }
  }
  const bounds = [0, ...cuts.map((c) => c.atM), total];
  const legs = [route.waypoints[0]?.leg ?? 'ROAD', ...cuts.map((c) => c.leg)];

  const pieces = [];
  for (let k = 0; k < legs.length; k++) {
    const from = bounds[k];
    const to = bounds[k + 1];
    if (!(to > from)) continue;
    const points = [pointAt(from)];
    for (let i = 0; i < poly.length; i++) {
      if (cum[i] <= from || cum[i] >= to) continue;
      const prev = points[points.length - 1];
      if (Math.hypot(poly[i].x - prev.x, poly[i].z - prev.z) > 0.05) points.push(poly[i]);
    }
    points.push(pointAt(to));
    if (points.length >= 2) {
      pieces.push({ points, halfWidthM: CORRIDOR_HALF_WIDTH[legs[k]] ?? CORRIDOR_HALF_WIDTH.PATH, leg: legs[k] });
    }
  }
  return pieces;
}

/**
 * Corredores de TODA la red OSM drapeada. Sin esto, la vista aerea muestra
 * arboles creciendo sobre las carreteras que no son la primera ruta.
 */
function buildRoadCorridors() {
  const path = resolve(root, 'public/roads/roads.json');
  if (!existsSync(path)) return [];
  const data = JSON.parse(readFileSync(path, 'utf8'));
  const out = [];
  for (const road of data.roads ?? []) {
    const points = (road.points ?? []).map(([x, z]) => ({ x, z }));
    if (points.length < 2) continue;
    out.push({ points, halfWidthM: CORRIDOR_HALF_WIDTH[road.class] ?? CORRIDOR_HALF_WIDTH.PATH, leg: road.class });
  }
  return out;
}

const routeCorridors = buildRouteCorridors(FIRST_ROUTE);
const roadCorridors = buildRoadCorridors();
const clearings = [
  { x: r1(FIRST_ROUTE.start.x), z: r1(FIRST_ROUTE.start.z), radiusM: START_CLEAR_RADIUS_M, role: 'start' },
  { x: r1(FIRST_ROUTE.target.x), z: r1(FIRST_ROUTE.target.z), radiusM: FIRST_ROUTE.targetClearRadiusM, role: 'target' },
];

// ---------------------------------------------- indice espacial de corredores
// Cada segmento se registra en TODAS las celdas que cubre su bbox inflado por
// el semiancho: ahi un punto solo mira su propia celda y el test es O(1).
const CORR_CELL = 100;
const corridorGrid = new Map();
for (const corridor of [...routeCorridors, ...roadCorridors]) {
  const pad = corridor.halfWidthM;
  for (let i = 0; i + 1 < corridor.points.length; i++) {
    const a = corridor.points[i];
    const b = corridor.points[i + 1];
    const ci0 = Math.floor((Math.min(a.x, b.x) - pad) / CORR_CELL);
    const ci1 = Math.floor((Math.max(a.x, b.x) + pad) / CORR_CELL);
    const cj0 = Math.floor((Math.min(a.z, b.z) - pad) / CORR_CELL);
    const cj1 = Math.floor((Math.max(a.z, b.z) + pad) / CORR_CELL);
    for (let cj = cj0; cj <= cj1; cj++) {
      for (let ci = ci0; ci <= ci1; ci++) {
        const key = pairKey(ci, cj);
        const list = corridorGrid.get(key);
        const seg = { a, b, halfWidthM: corridor.halfWidthM };
        if (list) list.push(seg);
        else corridorGrid.set(key, [seg]);
      }
    }
  }
}

/** true si (x,z) cae dentro de algún corredor (test exacto, celda propia). */
function inCorridor(x, z) {
  const list = corridorGrid.get(pairKey(Math.floor(x / CORR_CELL), Math.floor(z / CORR_CELL)));
  if (!list) return false;
  for (const seg of list) {
    if (pointSegmentDistance(x, z, seg.a.x, seg.a.z, seg.b.x, seg.b.z) <= seg.halfWidthM) return true;
  }
  return false;
}

const inClearing = (x, z) => clearings.some((c) => Math.hypot(x - c.x, z - c.z) <= c.radiusM);

// ------------------------------------------------- campo de distancia a la ruta
// Un lookup O(1) por candidato. Medir la distancia a ~235 segmentos por cada
// candidato (~20 M de operaciones) no vale la pena cuando el valor alimenta una
// funcion suave: 20 m de error no mueven la aguja de la densidad.
const FN = Math.round((WINDOW.maxX - WINDOW.minX) / FIELD_STEP_M) + 1;
const routeField = new Float32Array(FN * FN);
{
  const segs = [];
  for (const c of routeCorridors) {
    for (let i = 0; i + 1 < c.points.length; i++) segs.push([c.points[i], c.points[i + 1]]);
  }
  for (let j = 0; j < FN; j++) {
    const z = WINDOW.minZ + j * FIELD_STEP_M;
    for (let i = 0; i < FN; i++) {
      const x = WINDOW.minX + i * FIELD_STEP_M;
      let best = FIELD_MAX_M;
      for (const [a, b] of segs) {
        const d = pointSegmentDistance(x, z, a.x, a.z, b.x, b.z);
        if (d < best) best = d;
      }
      routeField[j * FN + i] = best;
    }
  }
}
function routeDistance(x, z) {
  const i = Math.min(FN - 1, Math.max(0, Math.round((x - WINDOW.minX) / FIELD_STEP_M)));
  const j = Math.min(FN - 1, Math.max(0, Math.round((z - WINDOW.minZ) / FIELD_STEP_M)));
  return routeField[j * FN + i];
}

// --------------------------------------------------------------- landcover OSM
/** Clasificacion pedida por la milestone: FOREST / GRASS / FIELDS. */
function classify(tags) {
  if (!tags) return null;
  if (tags.landuse === 'forest' || tags.natural === 'wood') return 'FOREST';
  if (tags.natural === 'grassland' || tags.natural === 'scrub' || tags.landuse === 'meadow') return 'GRASS';
  if (tags.landuse === 'farmland') return 'FIELDS';
  return null;
}

const samePoint = (a, b) => Math.abs(a.lat - b.lat) < 1e-9 && Math.abs(a.lon - b.lon) < 1e-9;

/**
 * Une los `way` members de una relacion en anillos cerrados.
 * `out body geom` NO trae ids de nodos, asi que el encadenamiento se hace por
 * coordenada exacta (comparten nodo => misma lat/lon en el JSON). Sin esto, un
 * bosque partido por una pista se cerraria con una cuerda recta y la mitad del
 * poligono quedaria fuera de la siembra.
 */
function chainRings(memberWays) {
  const open = memberWays.filter((m) => m.geometry && m.geometry.length >= 2).map((m) => m.geometry.slice());
  const rings = [];
  while (open.length > 0) {
    let cur = open.pop();
    let grew = true;
    while (grew && !samePoint(cur[0], cur[cur.length - 1])) {
      grew = false;
      for (let i = 0; i < open.length; i++) {
        const cand = open[i];
        const head = cur[cur.length - 1];
        const tail = cur[0];
        if (samePoint(head, cand[0])) cur = cur.concat(cand.slice(1));
        else if (samePoint(head, cand[cand.length - 1])) cur = cur.concat(cand.slice(0, -1).reverse());
        else if (samePoint(tail, cand[cand.length - 1])) cur = cand.slice(0, -1).concat(cur);
        else if (samePoint(tail, cand[0])) cur = cand.slice().reverse().concat(cur.slice(1));
        else continue;
        open.splice(i, 1);
        grew = true;
        break;
      }
    }
    if (cur.length >= 3) rings.push(cur);
  }
  return rings;
}

function loadLandcover() {
  const raw = readFileSync(SOURCE_FILE);
  const data = JSON.parse(raw.toString('utf8'));
  const memberWays = new Set();
  for (const el of data.elements) {
    if (el.type !== 'relation') continue;
    for (const m of el.members ?? []) if (m.type === 'way') memberWays.add(m.ref);
  }

  const byClass = { FOREST: [], GRASS: [], FIELDS: [] };
  const stats = { ways: 0, relations: 0 };
  // Orden fijo: way primero, luego por id. La siembra no depende de este orden
  // (cada celda se reclama una sola vez), pero el reporte si.
  const elements = [...data.elements].sort((a, b) => (a.type === b.type ? a.id - b.id : a.type === 'way' ? -1 : 1));

  for (const el of elements) {
    const cls = classify(el.tags);
    if (!cls) continue;
    if (el.type === 'way') {
      const geometry = el.geometry ?? [];
      if (geometry.length < 3) continue;
      const closed =
        Math.abs(geometry[0].lat - geometry[geometry.length - 1].lat) < 1e-12 &&
        Math.abs(geometry[0].lon - geometry[geometry.length - 1].lon) < 1e-12;
      // Un way ABIERTO que es miembro de una relacion no se cierra con cuerda:
      // el anillo correcto lo arma la relacion (chaining de arriba).
      if (!closed && memberWays.has(el.id)) continue;
      byClass[cls].push({ id: el.id, tags: el.tags, rings: [geometry] });
      stats.ways++;
    } else {
      const outers = (el.members ?? []).filter((m) => m.type === 'way' && m.role !== 'inner');
      const inners = (el.members ?? []).filter((m) => m.type === 'way' && m.role === 'inner');
      const rings = [...chainRings(outers), ...chainRings(inners)];
      if (rings.length === 0) continue;
      byClass[cls].push({ id: 1e12 + el.id, tags: el.tags, rings });
      stats.relations++;
    }
  }
  for (const list of Object.values(byClass)) list.sort((a, b) => a.id - b.id);
  return { data, rawSha: sha256(raw), rawBytes: raw.length, byClass, stats };
}

/** Punto en poligono (even-odd) sobre anillos YA proyectados a [x, z] de mundo. */
function pointInRings(x, z, rings) {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const az = ring[j][1];
      const bz = ring[i][1];
      if (az > z !== bz > z) {
        const t = (z - az) / (bz - az);
        if (x < ring[j][0] + t * (ring[i][0] - ring[j][0])) inside = !inside;
      }
    }
  }
  return inside;
}

// ------------------------------------------------------------ siembra jitterada
const priorityOf = (seederId, distance) => {
  const p = PRIORITY[seederId];
  return Math.max(p.min, 1 / (1 + (distance / p.d) ** 2));
};

const tierOf = (distance) => (distance <= TIER_NEAR_M ? 'near' : distance <= TIER_MID_M ? 'mid' : 'far');

/**
 * Tipo por instancia. Si OSM trae `leaf_type` se respeta: un pinar no se llena
 * de robles. Sin tag, una mezcla fija (robles dominan en las laderas de Oca).
 */
function pickType(kind, tags, u) {
  if (kind === 'grass') return 'hierba';
  if (kind === 'shrub') return u < 0.6 ? 'jaral' : 'enebro';
  const leaf = tags?.leaf_type;
  if (leaf === 'needleleaved') return u < 0.85 ? 'pino' : 'roble';
  if (leaf === 'broadleaved') return u < 0.6 ? 'roble' : 'abedul';
  return u < 0.45 ? 'roble' : u < 0.8 ? 'pino' : 'abedul';
}

const SEEDERS = [
  { id: 'forest-trees', classes: ['FOREST'], kind: 'tree' },
  { id: 'field-trees', classes: ['FIELDS'], kind: 'tree' },
  { id: 'grass-shrubs', classes: ['GRASS'], kind: 'shrub' },
  { id: 'grass-tufts', classes: ['GRASS', 'FIELDS'], kind: 'grass' },
];

function derive() {
  const landcover = loadLandcover();

  // Pre-proyecta los anillos UNA vez: la siembra los miles de veces.
  const projected = {};
  for (const [cls, polys] of Object.entries(landcover.byClass)) {
    projected[cls] = polys.map((poly) => {
      const world = poly.rings.map((ring) => ring.map((g) => wgs84ToWorld(config, g.lon, g.lat)));
      let minX = Infinity;
      let maxX = -Infinity;
      let minZ = Infinity;
      let maxZ = -Infinity;
      for (const ring of world) {
        for (const [x, z] of ring) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (z < minZ) minZ = z;
          if (z > maxZ) maxZ = z;
        }
      }
      return { ...poly, world, bbox: { minX, maxX, minZ, maxZ } };
    });
  }

  const instances = [];
  const excluded = { corridor: 0, clearing: 0, outside: 0 };
  const byClass = { FOREST: 0, GRASS: 0, FIELDS: 0 };
  const bySeeder = {};

  for (const seeder of SEEDERS) {
    const spacing = SPACING[seeder.id];
    // Cada celda se reclama UNA vez por siembra: si dos poligonos se pisan, la
    // densidad no se duplica y quien gana es determinista (orden por id).
    const claimed = new Set();
    let emitted = 0;

    for (const cls of seeder.classes) {
      for (const poly of projected[cls]) {
        const { bbox } = poly;
        const i0 = Math.ceil(Math.max(bbox.minX, WINDOW.minX) / spacing);
        const i1 = Math.floor(Math.min(bbox.maxX, WINDOW.maxX) / spacing);
        const j0 = Math.ceil(Math.max(bbox.minZ, WINDOW.minZ) / spacing);
        const j1 = Math.floor(Math.min(bbox.maxZ, WINDOW.maxZ) / spacing);
        for (let j = j0; j <= j1; j++) {
          for (let i = i0; i <= i1; i++) {
            const key = pairKey(i, j);
            if (claimed.has(key)) continue;
            const x = i * spacing + (hashRand(i, j, 1) - 0.5) * 0.9 * spacing;
            const z = j * spacing + (hashRand(i, j, 2) - 0.5) * 0.9 * spacing;
            if (x < WINDOW.minX || x > WINDOW.maxX || z < WINDOW.minZ || z > WINDOW.maxZ) continue;
            let owner = null;
            for (const candidate of projected[cls]) {
              const b = candidate.bbox;
              if (x < b.minX || x > b.maxX || z < b.minZ || z > b.maxZ) continue;
              if (pointInRings(x, z, candidate.world)) {
                owner = candidate;
                break;
              }
            }
            if (!owner) continue;
            claimed.add(key);

            const distance = routeDistance(x, z);
            if (hashRand(i, j, 3) >= priorityOf(seeder.id, distance)) continue;

            const px = r1(x);
            const pz = r1(z);
            if (px < WINDOW.minX || px > WINDOW.maxX || pz < WINDOW.minZ || pz > WINDOW.maxZ) {
              excluded.outside++;
              continue;
            }
            // El despeje se evalua sobre el valor YA redondeado que se publica.
            if (inCorridor(px, pz)) {
              excluded.corridor++;
              continue;
            }
            if (inClearing(px, pz)) {
              excluded.clearing++;
              continue;
            }

            const uScale = hashRand(i, j, 5);
            const kind = seeder.kind;
            const scale = kind === 'shrub' ? 0.7 + uScale * 0.6 : 0.8 + uScale * 0.6;
            instances.push({
              x: px,
              z: pz,
              type: pickType(kind, owner.tags, hashRand(i, j, 4)),
              scale: r3(scale),
              rotation: r3(hashRand(i, j, 6) * Math.PI * 2),
              tier: tierOf(distance),
            });
            emitted++;
            byClass[cls]++;
          }
        }
      }
    }
    bySeeder[seeder.id] = emitted;
  }

  // Orden estable de salida: z, luego x, luego tipo. Nada depende de la memoria.
  instances.sort((a, b) => a.z - b.z || a.x - b.x || (a.type < b.type ? -1 : a.type > b.type ? 1 : 0));

  const byType = {};
  const byTier = { near: 0, mid: 0, far: 0 };
  for (const inst of instances) {
    byType[inst.type] = (byType[inst.type] ?? 0) + 1;
    byTier[inst.tier]++;
  }

  const meta = {
    schemaVersion: 1,
    fecha: new Date().toISOString(),
    script: 'scripts/environment/build_vegetation.mjs',
    scriptSha256: sha256(readFileSync(fileURLToPath(import.meta.url))),
    semilla: SEED,
    source: {
      file: 'data/gameplay/raw/osm_landcover_window.json',
      bytes: landcover.rawBytes,
      sha256: landcover.rawSha,
      osm_timestamp: landcover.data.osm3s?.timestamp_osm_base ?? null,
      generator: landcover.data.generator ?? null,
      license: 'ODbL-1.0 (OpenStreetMap contributors)',
      anillos: { ways: landcover.stats.ways, relaciones: landcover.stats.relations },
    },
    window: { ...WINDOW },
    dato_ausente: 'no hay "y": la altura la pide el runtime a terrain.heightAt(x, z)',
    tier_definicion:
      `tier = banda de DISTANCIA A LA PRIMERA RUTA (${TIER_NEAR_M} m / ${TIER_MID_M} m). ` +
      'Con la camara sobre la ruta es tambien la banda de distancia a la camara; el LOD ' +
      'que se dibuja se recalcula en runtime contra la camara real.',
    prioridad: PRIORITY,
    spacing_m: SPACING,
    despeje: {
      corredores_total: routeCorridors.length + roadCorridors.length,
      corredores_ruta: routeCorridors.map((c) => ({ leg: c.leg, halfWidthM: c.halfWidthM, puntos: c.points.length })),
      corredores_red_vial: roadCorridors.length,
      claros: clearings,
    },
    conteos: {
      total: instances.length,
      por_clase: byClass,
      por_tipo: byType,
      por_tier: byTier,
      por_siembra: bySeeder,
      excluidos: excluded,
    },
  };

  return { meta, instances };
}

function serialize(built) {
  const lines = built.instances.map((i) => ' ' + JSON.stringify(i));
  return `{\n"meta": ${JSON.stringify(built.meta, null, 2)},\n"instances": [\n${lines.join(',\n')}\n]\n}\n`;
}

// --------------------------------------------- alturas contra el heightfield real
function buildHeightProbe() {
  const dir = resolve(root, 'public/terrain/tiles');
  const files = existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => /^tile_\d+_\d+\.json$/.test(f))
        .sort()
    : [];
  const samplers = [];
  const grids = [];
  let minAbs = Infinity;
  let maxAbs = -Infinity;
  for (const file of files) {
    const tile = JSON.parse(readFileSync(resolve(dir, file), 'utf8'));
    samplers.push(createHeightfield(tile.grid, config.worldScale));
    grids.push(tile.grid);
    for (const h of tile.grid.heights) {
      if (h < minAbs) minAbs = h;
      if (h > maxAbs) maxAbs = h;
    }
  }

  // Mismo encadenado que `src/terrain.ts`: tile que CONTIENE el punto y, si no
  // hay, el de centro mas cercano. La interpolacion es la del heightfield real.
  const resolveSampler = (x, z) => {
    for (const s of samplers) if (containsPoint(s.grid, x, z)) return s;
    let best = null;
    let bestD = Infinity;
    for (const s of samplers) {
      const e = gridExtent(s.grid);
      const d = (x - e.centerX) ** 2 + (z - e.centerZ) ** 2;
      if (d < bestD) {
        bestD = d;
        best = s;
      }
    }
    return best;
  };

  const clampX = (v) => Math.min(WINDOW.maxX, Math.max(WINDOW.minX, v));
  const clampZ = (v) => Math.min(WINDOW.maxZ, Math.max(WINDOW.minZ, v));

  return {
    tiles: samplers.length,
    minWorld: minAbs - datum,
    maxWorld: maxAbs - datum,
    heightAt: (x, z) => {
      const cx = clampX(x);
      const cz = clampZ(z);
      const s = resolveSampler(cx, cz);
      return s ? s.heightAt(cx, cz) - datum : Number.NaN;
    },
    /** Cota del NODO de grilla mas cercano: lectura directa, SIN interpolacion. */
    nodeAt: (x, z) => {
      const cx = clampX(x);
      const cz = clampZ(z);
      const s = resolveSampler(cx, cz);
      if (!s) return null;
      const g = s.grid;
      const i = Math.min(g.columns - 1, Math.max(0, Math.round((cx - g.x0) / g.dx)));
      const j = Math.min(g.rows - 1, Math.max(0, Math.round((cz - g.z0) / g.dz)));
      return g.heights[j * g.columns + i];
    },
    /**
     * Rango [min, max] de las 4 esquinas de la celda que CONTIENE el punto,
     * leido directo del array (mismo floor/clamp que `createHeightfield`).
     * Es la referencia independiente de la interpolacion: cualquier bilineal
     * correcta devuelve algo dentro de ese rango, porque es una combinacion
     * convexa de las esquinas. Umbral FIJO en metros seria un error: en este
     * DEM hay celdas de 5 m con 10 m de desnivel (laderas de ~60°).
     */
    cellSpan: (x, z) => {
      const cx = clampX(x);
      const cz = clampZ(z);
      const s = resolveSampler(cx, cz);
      if (!s) return null;
      const g = s.grid;
      const i = Math.min(g.columns - 2, Math.max(0, Math.floor((cx - g.x0) / g.dx)));
      const j = Math.min(g.rows - 2, Math.max(0, Math.floor((cz - g.z0) / g.dz)));
      const h = g.heights;
      const a = h[j * g.columns + i];
      const b = h[j * g.columns + i + 1];
      const c = h[(j + 1) * g.columns + i];
      const d = h[(j + 1) * g.columns + i + 1];
      if (a === undefined || b === undefined || c === undefined || d === undefined) return null;
      return { lo: Math.min(a, b, c, d) - datum, hi: Math.max(a, b, c, d) - datum };
    },
  };
}

// ----------------------------------------------------------------------- main
const built = derive();
const counts = built.meta.conteos;
const trees = (counts.por_tipo.roble ?? 0) + (counts.por_tipo.pino ?? 0) + (counts.por_tipo.abedul ?? 0);
const shrubs = (counts.por_tipo.jaral ?? 0) + (counts.por_tipo.enebro ?? 0);

console.log(`vegetación: ${counts.total} instancias · ${trees} árboles · ${shrubs} arbustos · ${counts.por_tipo.hierba ?? 0} matas`);
console.log(
  `  tier ${counts.por_tier.near} near / ${counts.por_tier.mid} mid / ${counts.por_tier.far} far · ` +
    `excluidos ${counts.excluidos.corridor} por corredor + ${counts.excluidos.clearing} por claro`,
);
console.log(`  por clase ${JSON.stringify(counts.por_clase)} · por siembra ${JSON.stringify(counts.por_siembra)}`);

if (!CHECK) {
  const OUT = resolve(root, 'public/vegetation/vegetation.json');
  mkdirSync(resolve(root, 'public/vegetation'), { recursive: true });
  const text = serialize(built);
  writeFileSync(OUT, text);
  console.log(`=> public/vegetation/vegetation.json (${(text.length / 1024 / 1024).toFixed(2)} MiB, sha256 ${sha256(text).slice(0, 16)}…)`);
  process.exit(0);
}

// ================================================================= modo --check
console.log('\n=== 1. re-derivación contra el archivo commiteado ===');
const OUT = resolve(root, 'public/vegetation/vegetation.json');
check('existe el JSON commiteado', existsSync(OUT), 'public/vegetation/vegetation.json');
if (!existsSync(OUT)) {
  console.log(`\n${pass}/${pass + fails.length} checks OK`);
  process.exit(1);
}
const committed = JSON.parse(readFileSync(OUT, 'utf8'));

check(
  'instances reproducibles byte a byte',
  JSON.stringify(committed.instances) === JSON.stringify(built.instances),
  `${committed.instances?.length ?? 0} vs ${built.instances.length}`,
);
const metaA = { ...committed.meta };
const metaB = { ...built.meta };
// `fecha` es la hora de corrida: compararla haria fallar siempre un build sano.
delete metaA.fecha;
delete metaB.fecha;
check('meta reproducible (salvo "fecha")', JSON.stringify(metaA) === JSON.stringify(metaB));
check(
  'meta.scriptSha256 corresponde al script actual',
  committed.meta?.scriptSha256 === sha256(readFileSync(fileURLToPath(import.meta.url))),
  'regenerá el JSON: el script cambió',
);
check('meta.source.sha256 corresponde al landcover actual', committed.meta?.source?.sha256 === sha256(readFileSync(SOURCE_FILE)));

console.log('\n=== 2. invariantes de las instancias ===');
const list = Array.isArray(committed.instances) ? committed.instances : [];
const total = list.length;
const tierSum = ['near', 'mid', 'far'].reduce((acc, t) => acc + list.filter((i) => i.tier === t).length, 0);
check('conteo total > 0', total > 0, `${total}`);
check('suma de tiers == total', tierSum === total, `${tierSum} vs ${total}`);
for (const t of ['near', 'mid', 'far']) {
  const n = list.filter((i) => i.tier === t).length;
  check(`tier ${t} > 0`, n > 0, `${n}`);
}
const REQUIRED_TYPES = ['roble', 'pino', 'abedul', 'jaral', 'enebro', 'hierba'];
check(
  'tipos: 3 árboles + 2 arbustos + hierba',
  REQUIRED_TYPES.every((t) => list.some((i) => i.type === t)),
  `${new Set(list.map((i) => i.type)).size} tipos distintos`,
);
check('meta.conteos.total == instances.length', committed.meta?.conteos?.total === total, `${committed.meta?.conteos?.total}`);

let outside = 0;
let badShape = 0;
let inCorr = 0;
let inClar = 0;
for (const i of list) {
  if (!(Number.isFinite(i.x) && Number.isFinite(i.z) && i.x >= WINDOW.minX && i.x <= WINDOW.maxX && i.z >= WINDOW.minZ && i.z <= WINDOW.maxZ)) outside++;
  if (typeof i.type !== 'string' || typeof i.tier !== 'string' || !Number.isFinite(i.scale) || !Number.isFinite(i.rotation)) badShape++;
  if (inCorridor(i.x, i.z)) inCorr++;
  if (inClearing(i.x, i.z)) inClar++;
}
check('ninguna instancia fuera de la ventana 6000×6000', outside === 0, `${outside} fuera`);
check('todas con la forma {x,z,type,scale,rotation,tier}', badShape === 0, `${badShape} malas`);
check('ninguna dentro de un corredor (ruta + red vial)', inCorr === 0, `${inCorr} adentro`);
check('ninguna dentro de un claro (inicio / objetivo)', inClar === 0, `${inClar} adentro`);

console.log('\n=== 3. alturas contra el heightfield real (nada flotando) ===');
const probe = buildHeightProbe();
check('se pudieron leer los 36 tiles', probe.tiles === 36, `${probe.tiles}`);
let nonFinite = 0;
let belowGround = 0;
let aboveGround = 0;
let worstResidual = 0;
let worstSlack = 0;
for (const i of list) {
  const y = probe.heightAt(i.x, i.z);
  if (!Number.isFinite(y)) {
    nonFinite++;
    continue;
  }
  // "Fuera de ventana" devuelve el absoluto sin restar (−870): eso dejaria el
  // árbol bajo tierra; un NaN lo dejaria en el origen. El rango real del DEM
  // acaza los dos casos sin depender del valor exacto.
  if (y < probe.minWorld - 0.01) belowGround++;
  if (y > probe.maxWorld + 0.01) aboveGround++;
  // Contraste INDEPENDIENTE de la interpolacion: cota del nodo de grilla mas
  // cercano (indice directo al array). Si el datum o el tile estuvieran mal,
  // esta diferencia se dispara.
  const node = probe.nodeAt(i.x, i.z);
  const span = probe.cellSpan(i.x, i.z);
  if (node === null || span === null) continue;
  const residual = Math.abs(y - (node - datum));
  if (residual > worstResidual) worstResidual = residual;
  // El umbral es el ancho de la celda que contiene el punto, no un metroje
  // inventado: la interpolacion bilineal es una combinacion convexa de las 4
  // esquinas, asi que SIEMPRE cae dentro del span. Un dato malo (tile corrido,
  // datum mal, fila/columna invertida) se sale del span aunque el terreno
  // sea llano.
  const slack = span.hi - span.lo;
  const over = residual - slack;
  if (over > worstSlack) worstSlack = over;
}
check('altura finita en TODAS las instancias', nonFinite === 0, `${nonFinite} no finitas`);
check('ninguna por debajo del DEM (>= min)', belowGround === 0, `${belowGround} bajo tierra`);
check('ninguna por encima del DEM (<= max)', aboveGround === 0, `${aboveGround} volando`);
check(
  'residual vs nodo de grilla dentro del span de su celda',
  worstSlack <= 1e-6,
  `peor residual ${worstResidual.toFixed(3)} m · exceso maximo ${worstSlack.toExponential(2)} m en ${total} muestras`,
);

const totalChecks = pass + fails.length;
console.log(`\n${pass}/${totalChecks} checks OK`);
if (fails.length > 0) {
  console.log('FALLARON:');
  for (const f of fails) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('TODO OK');
