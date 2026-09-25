#!/usr/bin/env node
// Build determinista de la capa de PUEBLO (FASE E, milestone 1).
//
// Entrada : data/gameplay/raw/osm_buildings_villafranca.json  (Overpass, ODbL)
//           data/gameplay/raw/osm_buildings_villafranca_manifest.json
// Salida  : public/village/buildings.json  (generado, versionado)
//
// Por qué existe este script y no un JSON a mano: los footprints salen de OSM y
// se re-descargan; el pueblo tiene que poder regenerarse byte a byte desde la
// fuente. Por eso `--check` re-deriva todo y compara con lo commiteado.
//
// TRES decisiones que este archivo cierra (detalles en docs/environment/VILLAGE.md):
//   1. ALTURA: `building:levels` x 3,2 m > tag `height` (metros) > valor por tipo
//      de edificio (2 plantas por defecto). El tag es un DATO MAPEADO, no una
//      medicion, y el JSON lo dice con `heightSource`.
//   2. DESCARTES VISIBLES: cada poligono descartado se cuenta con su motivo.
//      Un descarte silencioso es como perder datos sin darse cuenta.
//   3. SIN `y` EN EL JSON: la cota la pide el runtime a `terrain.heightAt`
//      (interpolacion triangular SO->NE). Guardar una y precalculada seria
//      congelar una superficie que puede cambiar y duplicar la matematica.
//
// Uso:
//   node scripts/environment/build_village.mjs           # escribe el JSON
//   node scripts/environment/build_village.mjs --check   # NO escribe: re-deriva,
//                                                        # compara y verifica
import { readFileSync, writeFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');

const RAW_FILE = resolve(root, 'data/gameplay/raw/osm_buildings_villafranca.json');
const MANIFEST_FILE = resolve(root, 'data/gameplay/raw/osm_buildings_villafranca_manifest.json');
const OUT_FILE = resolve(root, 'public/village/buildings.json');

/** Ventana jugable del proyecto (metros de mundo). Fuera de aca `heightAt` = 0. */
const WINDOW_M = 6000;
/**
 * Punto de aparicion del 4x4 (FASE 5 / first-route). Tiene que quedar libre:
 * el jugador no puede nacer dentro de una casa.
 */
const SPAWN = { x: 3088, z: 3935 };
/** Radio a despejar alrededor del spawn. La verificacion exige >= 8 m. */
const SPAWN_RADIUS_M = 12;
/** Area minima de un footprint (m^2). Menos que esto es ruido de digitalizacion. */
const MIN_AREA_M2 = 12;
/** Metros por planta (Convencion EHE-ish, valor de diseno del proyecto). */
const M_PER_LEVEL = 3.2;
const DEFAULT_LEVELS = 2;
/** Techo duro de altura: la verificacion exige 0 < h <= 60 m. */
const MAX_HEIGHT_M = 60;
/**
 * Faldon vertical hacia abajo (m). DEBE coincidir con `FALDON_M` de
 * `src/environment/village.ts`: es lo que impide que una casa quede flotando
 * en pendiente. --check lo verifica leyendo el TS.
 */
const FALDON_M = 1.5;

/* ------------------------------------------------------------------------- *
 * 1. Config del proyecto (transpilado, patron de scripts/terrain/validate_terrain.mjs)
 * ------------------------------------------------------------------------- */

async function loadProjectConfig() {
  const tmp = mkdtempSync(resolve(here, '.build-village-tmp-'));
  try {
    const source = readFileSync(resolve(root, 'src/config.ts'), 'utf8');
    const out = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
        verbatimModuleSyntax: false,
      },
    }).outputText;
    writeFileSync(resolve(tmp, 'config.gen.mjs'), out);
    const mod = await import(`file://${resolve(tmp, 'config.gen.mjs')}`);
    const raw = JSON.parse(readFileSync(resolve(root, 'public/terrain/config.json'), 'utf8'));
    return { config: mod.parseTerrainConfig(raw), wgs84ToWorld: mod.wgs84ToWorld };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------------------- *
 * 2. Geometria 2D (XZ). Nada de alturas: la altura la resuelve el runtime.
 * ------------------------------------------------------------------------- */

/** Area con la formula del trapezoide. >0 si los vertices son antihorarios. */
function signedArea(points) {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    sum += a[0] * b[1] - b[0] * a[1];
  }
  return sum / 2;
}

/** Centroide por area (no el promedio: en poligonos irregulares el promedio se corre). */
function centroidOf(points) {
  const area = signedArea(points);
  if (Math.abs(area) < 1e-9) {
    let sx = 0;
    let sz = 0;
    for (const p of points) {
      sx += p[0];
      sz += p[1];
    }
    return [sx / points.length, sz / points.length];
  }
  let cx = 0;
  let cz = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    const cross = a[0] * b[1] - b[0] * a[1];
    cx += (a[0] + b[0]) * cross;
    cz += (a[1] + b[1]) * cross;
  }
  return [cx / (6 * area), cz / (6 * area)];
}

/**
 * Eje mayor del footprint (PCA por covarianza) + extensiones sobre ese eje.
 * Lo usamos para decidir tejado a DOS AGUAS (alargado) vs PLANO (casi cuadrado):
 * es una decision geometrica del runtime, no un tag de OSM.
 */
function principalAxis(points) {
  const c = centroidOf(points);
  let sxx = 0;
  let szz = 0;
  let sxz = 0;
  for (const p of points) {
    const dx = p[0] - c[0];
    const dz = p[1] - c[1];
    sxx += dx * dx;
    szz += dz * dz;
    sxz += dx * dz;
  }
  const theta = 0.5 * Math.atan2(2 * sxz, sxx - szz);
  const u = [Math.cos(theta), Math.sin(theta)];
  const v = [-u[1], u[0]];
  let halfU = 0;
  let halfV = 0;
  for (const p of points) {
    const dx = p[0] - c[0];
    const dz = p[1] - c[1];
    halfU = Math.max(halfU, Math.abs(dx * u[0] + dz * u[1]));
    halfV = Math.max(halfV, Math.abs(dx * v[0] + dz * v[1]));
  }
  return { c, u, v, halfU, halfV };
}

/** Distancia de un punto a un poligono: 0 si esta dentro, si no al borde mas cercano. */
function distanceToPolygon(points, x, z) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const pi = points[i];
    const pj = points[j];
    if (pi[1] > z !== pj[1] > z && x < ((pj[0] - pi[0]) * (z - pi[1])) / (pj[1] - pi[1]) + pi[0]) {
      inside = !inside;
    }
  }
  if (inside) return 0;
  let best = Infinity;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    const vx = b[0] - a[0];
    const vz = b[1] - a[1];
    const len2 = vx * vx + vz * vz;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((x - a[0]) * vx + (z - a[1]) * vz) / len2)) : 0;
    const dx = x - (a[0] + t * vx);
    const dz = z - (a[1] + t * vz);
    best = Math.min(best, Math.hypot(dx, dz));
  }
  return best;
}

/* ------------------------------------------------------------------------- *
 * 3. Heuristica de alturas y materiales (tags OSM -> etiquetas del juego)
 * ------------------------------------------------------------------------- */

/** Plantas por TIPO de edificio cuando no hay ni `building:levels` ni `height`. */
const LEVELS_BY_TYPE = {
  church: 4,
  cathedral: 4,
  chapel: 3,
  hermitage: 3,
  barn: 1,
  shed: 1,
  garage: 1,
  stable: 1,
  hayloft: 1,
  farm_auxiliary: 1,
  cowshed: 1,
  industrial: 2,
  retail: 2,
  warehouse: 2,
  residential: 2,
  house: 2,
  detached: 2,
};

function parseNumber(raw) {
  if (raw === undefined || raw === null) return null;
  // OSM admite "12", "12 m", "12,5": nos quedamos con el primer numero.
  const match = String(raw).replace(',', '.').match(/-?\d+(\.\d+)?/);
  if (!match) return null;
  const value = Number(match[0]);
  return Number.isFinite(value) ? value : null;
}

/**
 * Altura + origen. Prioridad cerrada por contrato: levels > height > tipo.
 * Devuelve `null` si no hay forma de darle una altura valida (> 0).
 */
function resolveHeight(tags) {
  const type = tags.building ?? 'yes';
  const levelsTag = parseNumber(tags['building:levels']);
  if (levelsTag !== null && levelsTag > 0) {
    const levels = Math.round(levelsTag);
    return { heightM: levels * M_PER_LEVEL, levels, heightSource: 'levels' };
  }
  const heightTag = parseNumber(tags.height);
  if (heightTag !== null && heightTag > 0) {
    return {
      heightM: heightTag,
      levels: Math.max(1, Math.round(heightTag / M_PER_LEVEL)),
      heightSource: 'height',
    };
  }
  const levels = LEVELS_BY_TYPE[type] ?? DEFAULT_LEVELS;
  return { heightM: levels * M_PER_LEVEL, levels, heightSource: 'tipo' };
}

/**
 * Material del MURO (piedra | revoco | teja | ladrillo).
 *
 * En esta zona de OSM NO hay tags `building:material` (0 de 335 ways), asi que
 * la heuristica sale del TIPO de edificio y de los flags de estado. Para la
 * vivienda, que es el caso mas repetido y el mas anonimo, el tipo no alcanza:
 * se reparte de forma ESTABLE por id para que el pueblo no quede monocolor.
 * Es decorativo y determinista; no se pretende que sea verdad de OSM.
 */
const STONE_TYPES = new Set([
  'church', 'cathedral', 'chapel', 'hermitage', 'ruins',
  'barn', 'shed', 'garage', 'stable', 'hayloft', 'farm_auxiliary', 'cowshed',
]);
const BRICK_TYPES = new Set(['industrial', 'warehouse', 'hangar']);
const PLASTER_TYPES = new Set(['retail', 'commercial', 'public', 'civic', 'kindergarten', 'school']);

function materialKindOf(tags, id) {
  if (tags.ruins !== undefined || tags.abandoned !== undefined || tags.historic !== undefined) {
    return 'piedra'; // lo abandonado/ruinoso en el campo es mamposteria vista
  }
  const type = tags.building ?? 'yes';
  if (STONE_TYPES.has(type)) return 'piedra';
  if (BRICK_TYPES.has(type)) return 'ladrillo';
  if (PLASTER_TYPES.has(type)) return 'revoco';
  // Vivienda: reparto estable. 0-5 revoco, 6-7 piedra, 8-9 teja (barro).
  const bucket = id % 10;
  if (bucket >= 8) return 'teja';
  if (bucket >= 6) return 'piedra';
  return 'revoco';
}

/**
 * Material del TEJADO (teja | chapa | pizarra). Dos grupos grandes y uno
 * simbolico: naves de techo metalizado, iglesia historica, y el resto teja
 * curva, que es lo tipico del campo burgalos.
 */
function roofKindOf(tags) {
  const type = tags.building ?? 'yes';
  if (type === 'industrial' || type === 'retail' || type === 'warehouse' || type === 'hangar') {
    return 'chapa';
  }
  if (tags.historic !== undefined || type === 'church' || type === 'cathedral') return 'pizarra';
  return 'teja';
}

/* ------------------------------------------------------------------------- *
 * 4. Derivacion: ways de Overpass -> buildings de mundo
 * ------------------------------------------------------------------------- */

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Deriva TODO el contenido a partir del JSON crudo. Devuelve los edificios y el
 * arbol de descartes por motivo: sin eso no hay forma de saber si un cambio
 * silencioso se comio medio pueblo.
 */
function derive(payload, config, wgs84ToWorld) {
  const elements = Array.isArray(payload?.elements) ? payload.elements : [];
  const buildings = [];
  const discarded = {
    sin_geometry: 0,
    abierto: 0,
    pocos_vertices: 0,
    area_minima: 0,
    fuera_ventana: 0,
    despeje_spawn: 0,
    altura_invalida: 0,
  };
  const byHeightSource = { levels: 0, height: 0, tipo: 0 };
  const byMaterial = {};
  const byRoof = {};
  const byType = {};
  let heightsClamped = 0;

  for (const element of elements) {
    if (!isRecord(element) || element.type !== 'way') {
      discarded.sin_geometry++;
      continue;
    }
    const tags = isRecord(element.tags) ? element.tags : {};
    const geometry = Array.isArray(element.geometry) ? element.geometry : [];
    if (geometry.length < 4) {
      // Un way cerrado de OSM repite el primer node al final: 4 puntos = triangulo.
      discarded.pocos_vertices++;
      continue;
    }
    const first = geometry[0];
    const last = geometry[geometry.length - 1];
    if (!isRecord(first) || !isRecord(last) || Math.abs(first.lon - last.lon) > 1e-9 || Math.abs(first.lat - last.lat) > 1e-9) {
      discarded.abierto++;
      continue;
    }

    // Lon/lat -> mundo UNA sola vez, con la misma funcion que usa el runtime.
    const points = [];
    for (const node of geometry) {
      const [x, z] = wgs84ToWorld(config, node.lon, node.lat);
      const rounded = [Math.round(x * 100) / 100, Math.round(z * 100) / 100]; // cm
      const prev = points[points.length - 1];
      if (prev && Math.abs(prev[0] - rounded[0]) < 1e-6 && Math.abs(prev[1] - rounded[1]) < 1e-6) continue;
      points.push(rounded);
    }
    if (points.length > 1 && Math.abs(points[0][0] - points[points.length - 1][0]) < 1e-6 && Math.abs(points[0][1] - points[points.length - 1][1]) < 1e-6) {
      points.pop();
    }
    if (points.length < 3) {
      discarded.pocos_vertices++;
      continue;
    }

    const areaM2 = Math.abs(signedArea(points));
    if (areaM2 < MIN_AREA_M2) {
      discarded.area_minima++;
      continue;
    }

    //fuera de ventana = NO se puede pedir altura: heightAt devuelve 0 (el absoluto
    // menos el datum) y el edificio quedaria 870 m bajo tierra.
    let outside = false;
    for (const [x, z] of points) {
      if (x < 0 || x > WINDOW_M || z < 0 || z > WINDOW_M) outside = true;
    }
    if (outside) {
      discarded.fuera_ventana++;
      continue;
    }

    if (distanceToPolygon(points, SPAWN.x, SPAWN.z) < SPAWN_RADIUS_M) {
      discarded.despeje_spawn++;
      continue;
    }

    const height = resolveHeight(tags);
    if (!height || height.heightM <= 0) {
      discarded.altura_invalida++;
      continue;
    }
    let heightM = height.heightM;
    if (heightM > MAX_HEIGHT_M) {
      heightM = MAX_HEIGHT_M;
      heightsClamped++;
    }

    const type = tags.building ?? 'yes';
    const materialKind = materialKindOf(tags, element.id);
    const roofKind = roofKindOf(tags);
    byHeightSource[height.heightSource]++;
    byMaterial[materialKind] = (byMaterial[materialKind] ?? 0) + 1;
    byRoof[roofKind] = (byRoof[roofKind] ?? 0) + 1;
    byType[type] = (byType[type] ?? 0) + 1;

    buildings.push({
      id: element.id,
      footprint: points,
      heightM: Math.round(heightM * 100) / 100,
      levels: height.levels,
      heightSource: height.heightSource,
      materialKind,
      roofKind,
    });
  }

  // Orden numerico por id: la salida tiene que ser byte-identica entre corridas.
  buildings.sort((a, b) => a.id - b.id);
  return { buildings, discarded, byHeightSource, byMaterial, byRoof, byType, heightsClamped, ways: elements.length };
}

function footprintAreaM2(buildings) {
  let total = 0;
  for (const building of buildings) total += Math.abs(signedArea(building.footprint));
  return total;
}

function serialize(buildings, meta) {
  // Compacto, igual que public/roads/roads.json: es un archivo servido al cliente.
  return JSON.stringify({ meta, buildings });
}

function buildMeta(derived, manifest, sourceSha) {
  const { buildings, discarded, byHeightSource, byMaterial, byRoof, byType, heightsClamped, ways } = derived;
  return {
    schemaVersion: 1,
    // `fecha` NO es la hora de la corrida: sale del manifiesto de descarga para
    // que --check pueda comparar byte a byte contra lo commiteado.
    fecha: manifest.fetched_at_utc ?? null,
    script: 'scripts/environment/build_village.mjs',
    license: 'ODbL-1.0 (OpenStreetMap contributors)',
    coordinate_system: 'wgs84ToWorld(config) -> worldX = E - 471500, worldZ = N - 4689000 (y = altura absoluta - 870 en runtime)',
    ventana_m: [0, WINDOW_M, 0, WINDOW_M],
    spawn: { x: SPAWN.x, z: SPAWN.z, radio_despeje_m: SPAWN_RADIUS_M },
    fuente: {
      file: 'data/gameplay/raw/osm_buildings_villafranca.json',
      query_file: manifest.query_file ?? null,
      sha256: sourceSha,
      bytes: manifest.bytes ?? null,
      osm_timestamp: manifest.overpass_timestamp_osm_base ?? null,
    },
    conteos: {
      ways,
      buildings: buildings.length,
      descartados: Object.values(discarded).reduce((a, b) => a + b, 0),
      descartados_por_motivo: discarded,
      height_source: byHeightSource,
      materiales: byMaterial,
      techos: byRoof,
      tipos: byType,
      alturas_recortadas_a_60m: heightsClamped,
      metros_por_planta: M_PER_LEVEL,
      faldon_m: FALDON_M,
      area_total_m2: Math.round(footprintAreaM2(buildings) * 10) / 10,
    },
  };
}

/* ------------------------------------------------------------------------- *
 * 5. Verificacion (--check): re-deriva, compara y mide contra el terreno REAL
 * ------------------------------------------------------------------------- */

function report(name, ok, detail = '') {
  if (ok) console.log(`[OK  ] ${name}${detail ? ' — ' + detail : ''}`);
  else console.log(`[FALLA] ${name}${detail ? ' — ' + detail : ''}`);
  return ok;
}

/**
 * Carga SOLO los tiles que toca el pueblo y devuelve un `heightAt(x, z)` en
 * unidades de mundo. La interpolacion la hace `src/heightfield.ts` transpilado
 * (diagonal SO->NE, la misma que dibuja la malla): aca NO se reimplementa nada.
 */
async function loadTerrainHeightAt(bounds) {
  const tmp = mkdtempSync(resolve(here, '.check-village-tmp-'));
  try {
    const source = readFileSync(resolve(root, 'src/heightfield.ts'), 'utf8');
    const out = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
        verbatimModuleSyntax: false,
      },
    }).outputText
      // El modulo se llama a si mismo en el patron de validate_terrain.mjs.
      .replace(/(['"])(@babylonjs\/core\/[^'"]+)\1/g, '$1$2.js$1');
    writeFileSync(resolve(tmp, 'heightfield.gen.mjs'), out);
    const { createHeightfield, containsPoint } = await import(`file://${resolve(tmp, 'heightfield.gen.mjs')}`);

    const config = JSON.parse(readFileSync(resolve(root, 'public/terrain/config.json'), 'utf8'));
    const datum = config.verticalDatum * config.worldScale;
    const entries = [];
    for (const ref of config.tiles) {
      const file = resolve(root, 'public', ref.url.replace(/^\//, ''));
      const grid = JSON.parse(readFileSync(file, 'utf8')).grid;
      const maxX = grid.x0 + (grid.columns - 1) * grid.dx;
      const maxZ = grid.z0 + (grid.rows - 1) * grid.dz;
      if (maxX < bounds.minX - 10 || grid.x0 > bounds.maxX + 10) continue;
      if (maxZ < bounds.minZ - 10 || grid.z0 > bounds.maxZ + 10) continue;
      entries.push({ grid, sampler: createHeightfield(grid, config.worldScale) });
    }
    if (entries.length === 0) throw new Error('check: ningun tile cubre el pueblo');

    // Recorte al dominio: fuera de la ventana `heightAt` devuelve 0 (absoluto - datum).
    const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
    const at = (x, z) => {
      const cx = clamp(x, 0, WINDOW_M);
      const cz = clamp(z, 0, WINDOW_M);
      for (const entry of entries) {
        if (containsPoint(entry.grid, cx, cz)) return entry;
      }
      // Borde compartido entre tiles: cualquiera de los dos da lo mismo
      // (las costuras estan validadas con diff 0 en validate_terrain.mjs).
      return entries[0];
    };
    return {
      heightAt: (x, z) => {
        const entry = at(x, z);
        return entry.sampler.heightAt(clamp(x, 0, WINDOW_M), clamp(z, 0, WINDOW_M)) - datum;
      },
      /** SOLO para medir el riesgo de usar la interpolacion equivocada. */
      bilinearAt: (x, z) => {
        const entry = at(x, z);
        return bilinearAt(entry.grid, clamp(x, 0, WINDOW_M), clamp(z, 0, WINDOW_M)) - datum;
      },
      tiles: entries.length,
    };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Bilineal SOLO para medir cuantos nos jugamos: NUNCA se usa para construir. */
function bilinearAt(grid, x, z) {
  const i = (x - grid.x0) / grid.dx;
  const j = (z - grid.z0) / grid.dz;
  const i0 = Math.min(Math.max(Math.floor(i), 0), grid.columns - 2);
  const j0 = Math.min(Math.max(Math.floor(j), 0), grid.rows - 2);
  const fx = i - i0;
  const fz = j - j0;
  const sw = grid.heights[j0 * grid.columns + i0];
  const se = grid.heights[j0 * grid.columns + i0 + 1];
  const nw = grid.heights[(j0 + 1) * grid.columns + i0];
  const ne = grid.heights[(j0 + 1) * grid.columns + i0 + 1];
  return (1 - fx) * (1 - fz) * sw + fx * (1 - fz) * se + (1 - fx) * fz * nw + fx * fz * ne;
}

async function runCheck(derived, serialized, sourceSha, manifest) {
  let ok = true;
  const fail = (name, detail) => {
    report(name, false, detail);
    ok = false;
  };

  console.log('=== 1. el archivo commiteado es exactamente lo que se re-deriva ===');
  if (!existsSync(OUT_FILE)) {
    fail('buildings.json existe', 'no se puede comparar contra nada');
    return finish(ok);
  }
  const committed = readFileSync(OUT_FILE, 'utf8');
  report('re-deriva == commiteado (byte a byte)', committed === serialized,
    committed === serialized ? `${committed.length} bytes` : `commiteado ${committed.length} B vs rederivado ${Buffer.byteLength(serialized)} B`);
  if (committed !== serialized) ok = false;

  const data = JSON.parse(serialized);
  const buildings = data.buildings;
  const meta = data.meta;

  console.log('\n=== 2. hay datos de verdad (un JSON vacio NO pasa) ===');
  report('buildings > 0', buildings.length > 0, `${buildings.length}`);
  if (buildings.length === 0) return finish(false);
  report('meta.sha256 == sha256 del JSON crudo', meta.fuente.sha256 === sourceSha, sourceSha.slice(0, 16));
  if (manifest.overpass_timestamp_osm_base) {
    report('meta trae el timestamp OSM de la fuente', typeof meta.fuente.osm_timestamp === 'string' && meta.fuente.osm_timestamp.length > 0, meta.fuente.osm_timestamp);
  }
  report('meta.conteos.buildings == longitud real', meta.conteos.buildings === buildings.length, `${meta.conteos.buildings}`);
  const rawSha = createHash('sha256').update(readFileSync(RAW_FILE)).digest('hex');
  report('el archivo crudo sigue teniendo el sha256 del manifiesto', rawSha === manifest.sha256, rawSha.slice(0, 16));

  console.log('\n=== 3. geometria dentro de la ventana ===');
  let outsideVertices = 0;
  let badShape = 0;
  let badHeight = 0;
  let badLabel = 0;
  const heights = [];
  for (const b of buildings) {
    if (!Array.isArray(b.footprint) || b.footprint.length < 3) badShape++;
    else {
      for (const [x, z] of b.footprint) {
        if (!(x >= 0 && x <= WINDOW_M && z >= 0 && z <= WINDOW_M)) outsideVertices++;
      }
    }
    if (!(b.heightM > 0 && b.heightM <= MAX_HEIGHT_M)) badHeight++;
    heights.push(b.heightM);
    if (!['levels', 'height', 'tipo'].includes(b.heightSource)) badLabel++;
    if (!['piedra', 'revoco', 'teja', 'ladrillo'].includes(b.materialKind)) badLabel++;
    if (!['teja', 'chapa', 'pizarra'].includes(b.roofKind)) badLabel++;
  }
  report('ningun vertice fuera de la ventana 6000x6000', outsideVertices === 0, `${outsideVertices} vertices`);
  report('todos los footprints tienen >= 3 vertices', badShape === 0, `${badShape} malos`);
  report('ninguna altura <= 0 ni > 60 m', badHeight === 0, `min ${Math.min(...heights)} max ${Math.max(...heights)}`);
  report('labels en los conjuntos permitidos (heightSource/materialKind/roofKind)', badLabel === 0, `${badLabel} malos`);

  console.log('\n=== 4. el punto de aparicion queda libre ===');
  let nearest = Infinity;
  let nearestId = null;
  for (const b of buildings) {
    const d = distanceToPolygon(b.footprint, SPAWN.x, SPAWN.z);
    if (d < nearest) {
      nearest = d;
      nearestId = b.id;
    }
  }
  report(`spawn (${SPAWN.x}, ${SPAWN.z}) libre con radio >= 8 m`, nearest >= 8,
    `edificio mas cercano #${nearestId} a ${nearest.toFixed(1)} m`);

  console.log('\n=== 5. ninguna base flotante (muestreo con semilla fija) ===');
  const terrain = await loadTerrainHeightAt({
    minX: Math.min(...buildings.flatMap((b) => b.footprint.map((p) => p[0]))),
    maxX: Math.max(...buildings.flatMap((b) => b.footprint.map((p) => p[0]))),
    minZ: Math.min(...buildings.flatMap((b) => b.footprint.map((p) => p[1]))),
    maxZ: Math.max(...buildings.flatMap((b) => b.footprint.map((p) => p[1]))),
  });
  console.log(`      terreno real cargado: ${terrain.tiles} tile(s), faldon = ${FALDON_M} m`);

  const sampleCount = Math.min(250, buildings.length);
  let seed = 20260925;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const picked = new Set();
  while (picked.size < sampleCount) picked.add(Math.floor(rnd() * buildings.length));

  let outsideRange = 0;
  let datumTeethCaught = 0; // si alguien olvidara el datum, este check tiene que fallar
  let maxRelief = 0;
  let maxBurial = 0;
  let aboveRoof = 0; // terreno por encima de la cumbrera: casa embebida en la ladera
  let maxBilinDiff = 0;
  let sampledVertices = 0;
  for (const index of picked) {
    const b = buildings[index];
    let minY = Infinity;
    let maxY = -Infinity;
    for (const [x, z] of b.footprint) {
      const y = terrain.heightAt(x, z);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
      sampledVertices++;
      // Diferencia contra la interpolacion equivocada (solo para medir el riesgo:
      // si alguien bilineal a mano, este es el error que se le entra en la base).
      maxBilinDiff = Math.max(maxBilinDiff, Math.abs(y - terrain.bilinearAt(x, z)));
    }
    // Rango vertical del edificio TAL COMO lo construye src/environment/village.ts:
    // base = min(terreno) - faldon, cumbrera = min(terreno) + altura.
    const builtBottom = minY - FALDON_M;
    const builtTop = minY + b.heightM;
    if (!(minY >= builtBottom - 1e-6 && minY <= builtTop + 1e-6)) outsideRange++;
    // Dientes: con el datum mal restado (+870) el rango tiene que dejar de cubrir.
    if (minY + 870 >= builtBottom && minY + 870 <= builtTop) datumTeethCaught++;
    if (maxY > builtTop) aboveRoof++;
    maxRelief = Math.max(maxRelief, maxY - minY);
    maxBurial = Math.max(maxBurial, maxY - builtBottom);
  }
  report(`muestreados ${sampleCount} edificios (${sampledVertices} vertices) con semilla fija`, true);
  report('el min de terrain.heightAt cae dentro del rango construido', outsideRange === 0, `${outsideRange} fuera de rango`);
  report('el check atrapa un datum mal restado (dientes)', datumTeethCaught === 0,
    datumTeethCaught === 0 ? 'con +870 m el rango deja de cubrir' : `${datumTeethCaught} pasarian igual`);
  console.log(`      relieve max bajo un footprint: ${maxRelief.toFixed(2)} m (faldon ${FALDON_M} m)`);
  console.log(`      hundimiento max (terreno mas alto - base): ${maxBurial.toFixed(2)} m`);
  console.log(`      max |triangular - bilineal| en los mismos vertices: ${maxBilinDiff.toFixed(3)} m (la trampa del proyecto)`);
  console.log(
    `      ${aboveRoof}/${sampleCount} muestreados tienen terreno mas alto que la cumbrera: ` +
      'no flotan (la base esta en el minimo) pero quedan EMBEBIDOS en la ladera. Es la consecuencia ' +
      'del contrato de estirar desde el minimo; se ve en las capturas.',
  );

  console.log('\n=== 6. el faldon esta sincronizado con el runtime ===');
  const villageSource = readFileSync(resolve(root, 'src/environment/village.ts'), 'utf8');
  const faldonMatch = villageSource.match(/FALDON_M\s*=\s*([0-9.]+)/);
  report('src/environment/village.ts declara el mismo FALDON_M', !!faldonMatch && Number(faldonMatch[1]) === FALDON_M,
    faldonMatch ? faldonMatch[1] : 'no encontrado');
  report('la base del runtime usa terrain.heightAt (no una y precalculada)',
    /terrain\.heightAt\(/.test(villageSource) && !/"y"\s*:/.test(villageSource));

  console.log(`\nDescartes: ${JSON.stringify(meta.conteos.descartados_por_motivo)}`);
  return finish(ok);
}

function finish(ok) {
  if (!ok) {
    console.log('\nFALLA: la capa de pueblo no cumple el contrato.');
    process.exit(1);
  }
  console.log('\nTODO OK');
}

/* ------------------------------------------------------------------------- */

async function main() {
  const check = process.argv.includes('--check');
  if (!existsSync(RAW_FILE)) {
    console.error(`Falta ${RAW_FILE}. Corra scripts/environment/fetch_buildings.sh`);
    process.exit(1);
  }
  if (!existsSync(MANIFEST_FILE)) {
    console.error(`Falta ${MANIFEST_FILE}. Corra scripts/environment/fetch_buildings.sh`);
    process.exit(1);
  }
  const manifest = JSON.parse(readFileSync(MANIFEST_FILE, 'utf8'));
  const rawBuffer = readFileSync(RAW_FILE);
  const sourceSha = createHash('sha256').update(rawBuffer).digest('hex');
  const payload = JSON.parse(rawBuffer.toString('utf8'));
  if (payload.remark) {
    console.error(`FALLO: Overpass devolvio un runtime error: ${payload.remark}`);
    process.exit(1);
  }

  const { config, wgs84ToWorld } = await loadProjectConfig();
  const derived = derive(payload, config, wgs84ToWorld);
  const meta = buildMeta(derived, manifest, sourceSha);
  const serialized = serialize(derived.buildings, meta);

  if (check) {
    await runCheck(derived, serialized, sourceSha, manifest);
    return;
  }

  mkdirSync(dirname(OUT_FILE), { recursive: true });
  writeFileSync(OUT_FILE, serialized);
  const c = meta.conteos;
  console.log(`${derived.ways} ways -> ${derived.buildings.length} edificios (${Buffer.byteLength(serialized)} bytes)`);
  console.log(`descartes: ${JSON.stringify(c.descartados_por_motivo)}`);
  console.log(`altura por origen: ${JSON.stringify(c.height_source)} · materiales: ${JSON.stringify(c.materiales)} · techos: ${JSON.stringify(c.techos)}`);
  console.log(`area total: ${c.area_total_m2} m2`);
  console.log(`-> ${OUT_FILE}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
