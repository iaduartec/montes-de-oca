/**
 * FASE E — Pueblo de Villafranca: extrusiones de los footprints reales de OSM.
 *
 * `public/village/buildings.json` trae poligonos en coordenadas de MUNDO, sin `y`.
 * Este modulo es el unico que le pregunta la cota al terreno, y lo hace SIEMPRE
 * con `terrain.heightAt` (interpolacion triangular SO->NE, la misma superficie que
 * dibuja la malla y sobre la que rueda el 4x4). Reimplementar una bilineal aca
 * seria introducir hasta 0,29 m de error medido en la base de cada casa.
 *
 * Tres decisiones que cierra este archivo (detalles en docs/environment/VILLAGE.md):
 *
 *  1. BASE TOCANDO EL SUELO: cada casa se estira desde el MINIMO `heightAt` de sus
 *     vertices hacia arriba, y las paredes siguen 1,5 m mas hacia abajo (`FALDON_M`).
 *     En una ladera eso es lo que separa "pueblo" de "casas flotando": el minimo de
 *     una polilinea lineal siempre esta en un vertice, asi que el faldon cubre todo
 *     el borde del footprint sin importar la pendiente.
 *  2. POCAS MALLAS: los cuerpos se agrupan por material (4) y los tejados por
 *     material de techo (3). ~330 casas entran en pocas draw calls; una malla por
 *     casa serian 330 y mataria el frame en SwiftShader y en GPU.
 *  3. TEJADO SENCILLO: dos aguas si el footprint es alargado (PCA del poligono),
 *     plano si es casi cuadrado. Los huecos se limitan al entorno jugable:
 *     LOD de presupuesto, no de calidad.
 *  4. DETALLE SOLO CERCA DEL SPAWN: las casas a <=90 m del 4x4 suman puerta,
 *     ventanas, contraventanas, zocalo de piedra y alero. Los detalles se agrupan
 *     por material; el alero va al material del tejado. El resto queda como estaba.
 */

import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import { applyFacadeSurface, FACADE_TILE_METRES, type FacadeSurfaceCache } from './facade-materials';
import { SceneLoader } from '@babylonjs/core/Loading/sceneLoader';
import type { AssetContainer } from '@babylonjs/core/assetContainer';
import '@babylonjs/loaders/glTF';
import type { Scene } from '@babylonjs/core/scene';
import type { WorldTerrain } from '../terrain';
import { gridExtent } from '../heightfield';
import { buildingRoofTint, buildingTint } from './building-tint';
import { selectRoofShape } from './roof-shape';
import { constrainEaveOverhang, VILLAGE_DETAIL_RADIUS_M } from './roof-clearance';
import { nearestFacadeRoutePoint, selectVillageFacadeKit, type FacadeRoutePoint } from './village-facade-kits';
import { VILLAGE_PILOT_HOUSES, type VillagePilotHouseStyle } from './village-pilot';

/* ------------------------------------------------------------------------- *
 * Contrato (lo consumen main.ts cuando el orquestador integre las capas)
 * ------------------------------------------------------------------------- */

export interface VillageStats {
  readonly buildings: number;
  readonly meshes: number;
  readonly triangles: number;
  readonly footprintAreaM2: number;
  readonly tallestM: number;
  /** Edificios descartados por invadir el punto de aparición. */
  readonly droppedAtSpawn: number;
  /** Edificios que recibieron detalle de fachada (cerca del spawn). */
  readonly detailedBuildings: number;
  /** Tapias de patio generadas con despeje frente a edificios y vías. */
  readonly courtyardWalls: number;
  /** Casas cuya altura de cubierta se midió con el ráster LiDAR del IGN. */
  readonly lidarAdjustedBuildings: number;
  /** Casas que conservan altura OSM porque el ráster no tiene muestra suficiente. */
  readonly lidarFallbackBuildings: number;
  /** Casas de altura estimada cuya cubierta se elevó para despejar la ladera. */
  readonly roofLiftedBuildings: number;
  /** Máximo aumento de altura aplicado a una cubierta estimada (m). */
  readonly maxRoofLiftM: number;
  /** Postes de madera con cables colocados a lo largo de la calle del spawn. */
  readonly streetPoles: number;
}

export interface Village {
  readonly stats: VillageStats;
  dispose(): void;
}

export interface LoadVillageOptions {
  /** URL de los datos. Por defecto `/village/buildings.json`. */
  readonly url?: string;
  /** GLB del piloto. */
  readonly pilotAssetUrl?: string;
  /** Edificios sustituidos por hitos externos que se cargaron correctamente. */
  readonly omitBuildingIds?: ReadonlySet<number>;
  /** Manifiesto y rejilla independiente del MDSnE IGN/CNIG. */
  readonly buildingHeightGridUrl?: string;
  /** Punto que NO puede quedar tapado por una casa (la aparición del 4x4). */
  readonly keepClearAt?: { readonly x: number; readonly z: number } | null;
  /** Radio a despejar alrededor de `keepClearAt`, en metros. */
  readonly keepClearRadiusM?: number;
  /**
   * Centros de vía locales; cada muestra incluye el semiancho que debe quedar libre y,
   * si se conoce, la dirección `dx`/`dz` del eje (la usan los postes de la calle).
   */
  readonly mappedWallsUrl?: string;
  readonly facadeRoute?: { readonly points: readonly FacadeRoutePoint[]; readonly radiusM: number };
  readonly roadClearance?: readonly {
    readonly x: number;
    readonly z: number;
    readonly radiusM: number;
    readonly dx?: number;
    readonly dz?: number;
  }[];
}

/* ------------------------------------------------------------------------- *
 * Constantes de geometria
 * ------------------------------------------------------------------------- */

/**
 * Faldon vertical de las paredes bajo el punto mas bajo del footprint (m).
 * DEBE coincidir con `FALDON_M` de `scripts/environment/build_village.mjs`, que
 * lo verifica leyendo este archivo en `--check`.
 */
export const FALDON_M = 1.5;

/** Umbral de alargamiento del footprint para pasar de tejado plano a dos aguas. */
const GABLE_ELONGATION = 1.35;

/** Bajada maxima del alero en las cubiertas a cuatro aguas / a un agua (m). */
const HIP_MAX_DROP_M = 2.6;
const SHED_MAX_DROP_M = 2.2;
/** Separación mínima entre cubierta estimada y terreno bajo el footprint (m). */
const ROOF_CLEARANCE_M = 0.2;
/** Límite para no convertir errores puntuales del heightfield en casas altas (m). */
const ROOF_MAX_LIFT_M = 1.6;

/**
 * Hash determinista y barato del id OSM. La variante de una casa no debe cambiar
 * entre partidas ni depender del orden de carga.
 */
function hash32(id: number): number {
  let h = (id ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

/** Radio por defecto a despejar alrededor del spawn (contrato: >= 8 m verificado). */
const DEFAULT_KEEP_CLEAR_RADIUS_M = 12;

/**
 * Detalle de fachada y cubierta: edificios a <= esta distancia del spawn. El
 * resto del pueblo mantiene el LOD de presupuesto. 150 m cubren varias fachadas
 * de la calle inicial, suficientes para que el recorrido no cambie de casas
 * articuladas a cajas lisas tras solo dos manzanas.
 */

/* Medidas del detalle (m). Conservadoras: nada que invada calzada ni spawn. */
const PLINTH_HEIGHT_M = 0.55;
const PLINTH_OUT_M = 0.05;
const OPENING_OUT_M = 0.1;
const DOOR_WIDTH_M = 0.95;
const DOOR_HEIGHT_M = 2.0;
/** Porton de cuadra/cochera: la boca ancha de madera tipica del caserio. */
const PORTON_WIDTH_M = 1.9;
const PORTON_HEIGHT_M = 2.3;
const WINDOW_WIDTH_M = 0.7;
const WINDOW_HEIGHT_M = 0.95;
const WINDOW_SILL_M = 1.15;
const SHUTTER_WIDTH_M = 0.14;
const SHUTTER_GAP_M = 0.055;
const SHUTTER_OUT_M = 0.15;
const EAVE_OVERHANG_M = 0.35;
const EAVE_ROAD_GAP_M = 0.1;
const EAVE_FASCIA_M = 0.16;
const WINDOW_TRIM_OUT_M = OPENING_OUT_M + 0.025;
/** Longitud minima de fachada para colgar un hueco. */
const MIN_FACADE_M = 2.0;

const DEFAULT_URL = '/village/buildings.json';
const DEFAULT_BUILDING_HEIGHT_GRID_URL = '/village/building_height_grid.json';
const MIN_LIDAR_SAMPLES = 4;
const MIN_LIDAR_WALL_HEIGHT_M = 2;

/** Tipos de material. Cuerpos y tejados se agrupan por separado: 4 + 3 mallas. */
const BODY_KINDS = ['piedra', 'revoco', 'teja', 'ladrillo'] as const;
type BodyKind = (typeof BODY_KINDS)[number];

const ROOF_KINDS = ['teja', 'chapa', 'pizarra'] as const;
type RoofKind = (typeof ROOF_KINDS)[number];

interface MaterialSpec {
  readonly name: string;
  readonly diffuse: readonly [number, number, number];
  readonly roughness: number;
}

/**
 * Paleta compartida con superficies PBR de fachada y tintes por edificio.
 */
const BODY_MATERIALS: Record<BodyKind, MaterialSpec> = {
  piedra: { name: 'pueblo:muro-piedra', diffuse: [0.5, 0.46, 0.4], roughness: 0.97 },
  revoco: { name: 'pueblo:muro-revoco', diffuse: [0.82, 0.76, 0.66], roughness: 0.96 },
  teja: { name: 'pueblo:muro-teja', diffuse: [0.74, 0.6, 0.46], roughness: 0.94 },
  ladrillo: { name: 'pueblo:muro-ladrillo', diffuse: [0.62, 0.38, 0.3], roughness: 0.94 },
};

const ROOF_MATERIALS: Record<RoofKind, MaterialSpec> = {
  teja: { name: 'pueblo:techo-teja', diffuse: [0.6, 0.32, 0.24], roughness: 0.9 },
  chapa: { name: 'pueblo:techo-chapa', diffuse: [0.56, 0.58, 0.59], roughness: 0.72 },
  pizarra: { name: 'pueblo:techo-pizarra', diffuse: [0.32, 0.32, 0.36], roughness: 0.84 },
};

/**
 * Los DOS unicos lotes extra del detalle: huecos (puerta/ventana) y zocalo de
 * piedra. El alero reutiliza el material del tejado, asi que el total pasa de 7 a
 * 9 mallas (7 + 2) y no de mas.
 */
const DETAIL_MATERIAL: MaterialSpec = { name: 'pueblo:detalle', diffuse: [0.15, 0.14, 0.13], roughness: 0.93 };
const PLINTH_MATERIAL: MaterialSpec = { name: 'pueblo:zocalo', diffuse: [0.66, 0.6, 0.5], roughness: 0.98 };
const SHUTTER_MATERIAL: MaterialSpec = { name: 'pueblo:contraventanas', diffuse: [0.34, 0.25, 0.17], roughness: 0.9 };

/* ------------------------------------------------------------------------- *
 * Datos: parseo defensivo de buildings.json
 * ------------------------------------------------------------------------- */

type V2 = readonly [number, number];

interface Building {
  readonly id: number;
  readonly footprint: readonly V2[];
  readonly heightM: number;
  readonly levels: number;
  readonly heightSource: 'levels' | 'height' | 'tipo' | 'lidar';
  readonly materialKind: BodyKind;
  readonly roofKind: RoofKind;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseBuildings(raw: unknown): Building[] {
  if (!isRecord(raw)) throw new Error('pueblo: la raiz debe ser un objeto');
  const meta = raw.meta;
  const versionOk = raw.schemaVersion === 1 || (isRecord(meta) && meta.schemaVersion === 1);
  if (!versionOk) throw new Error('pueblo: schemaVersion no soportada');
  const list = raw.buildings;
  if (!Array.isArray(list)) throw new Error('pueblo: falta el array "buildings"');
  const out: Building[] = [];
  for (const item of list) {
    if (!isRecord(item)) continue;
    const footprint: V2[] = [];
    if (Array.isArray(item.footprint)) {
      for (const point of item.footprint) {
        if (!Array.isArray(point) || point.length < 2) continue;
        const x = point[0];
        const z = point[1];
        if (typeof x !== 'number' || typeof z !== 'number' || !Number.isFinite(x) || !Number.isFinite(z)) continue;
        footprint.push([x, z]);
      }
    }
    if (footprint.length < 3) continue;
    const heightM = item.heightM;
    if (typeof heightM !== 'number' || !Number.isFinite(heightM) || heightM <= 0) continue;
    out.push({
      id: typeof item.id === 'number' ? item.id : -1,
      footprint,
      heightM,
      levels: typeof item.levels === 'number' ? item.levels : 0,
      // Etiquetas fuera de catalogo -> valor por defecto (y el build las audita).
      heightSource: item.heightSource === 'height' || item.heightSource === 'tipo' ? item.heightSource : 'levels',
      materialKind: isBodyKind(item.materialKind) ? item.materialKind : 'revoco',
      roofKind: isRoofKind(item.roofKind) ? item.roofKind : 'teja',
    });
  }
  return out;
}

function isBodyKind(value: unknown): value is BodyKind {
  return typeof value === 'string' && (BODY_KINDS as readonly string[]).includes(value);
}

function isRoofKind(value: unknown): value is RoofKind {
  return typeof value === 'string' && (ROOF_KINDS as readonly string[]).includes(value);
}

interface BuildingHeightGrid {
  readonly width: number;
  readonly height: number;
  readonly pixelSizeM: number;
  readonly topLeftEastingM: number;
  readonly topLeftNorthingM: number;
  readonly values: Int16Array;
}

async function loadBuildingHeightGrid(url: string): Promise<BuildingHeightGrid> {
  const metaResponse = await fetch(url);
  if (!metaResponse.ok) throw new Error(`pueblo: no se pudo cargar ${url} (HTTP ${metaResponse.status})`);
  const raw: unknown = await metaResponse.json();
  if (!isRecord(raw) || raw.schemaVersion !== 1 || raw.crs !== 'EPSG:25830' || !isRecord(raw.grid)) {
    throw new Error('pueblo: manifiesto de alturas IGN no válido');
  }
  const grid = raw.grid;
  const width = grid.width;
  const height = grid.height;
  const pixelSizeM = grid.pixel_size_m;
  const topLeftEastingM = grid.top_left_easting_m;
  const topLeftNorthingM = grid.top_left_northing_m;
  if (
    typeof width !== 'number' || !Number.isInteger(width) || width <= 0 ||
    typeof height !== 'number' || !Number.isInteger(height) || height <= 0 ||
    typeof pixelSizeM !== 'number' || !Number.isFinite(pixelSizeM) || pixelSizeM <= 0 ||
    typeof topLeftEastingM !== 'number' || !Number.isFinite(topLeftEastingM) ||
    typeof topLeftNorthingM !== 'number' || !Number.isFinite(topLeftNorthingM) ||
    typeof raw.valuesFile !== 'string' || !raw.valuesFile
  ) {
    throw new Error('pueblo: metadatos de rejilla IGN incompletos');
  }

  const valuesUrl = new URL(raw.valuesFile, new URL(url, globalThis.location.href));
  const valuesResponse = await fetch(valuesUrl);
  if (!valuesResponse.ok) throw new Error(`pueblo: no se pudo cargar ${valuesUrl} (HTTP ${valuesResponse.status})`);
  const buffer = await valuesResponse.arrayBuffer();
  if (buffer.byteLength !== width * height * 2) {
    throw new Error(`pueblo: rejilla IGN de ${buffer.byteLength} bytes; se esperaban ${width * height * 2}`);
  }
  const data = new DataView(buffer);
  const values = new Int16Array(width * height);
  for (let i = 0; i < values.length; i++) values[i] = data.getInt16(i * 2, true);
  return { width, height, pixelSizeM, topLeftEastingM, topLeftNorthingM, values };
}

/* ------------------------------------------------------------------------- *
 * Geometria 2D
 * ------------------------------------------------------------------------- */

/** Area con signo. >0 si el recorrido es antihorario en el plano XZ. */
function signedArea(points: readonly V2[]): number {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    sum += a[0] * b[1] - b[0] * a[1];
  }
  return sum / 2;
}

function centroidOf(points: readonly V2[]): V2 {
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
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    const cross = a[0] * b[1] - b[0] * a[1];
    cx += (a[0] + b[0]) * cross;
    cz += (a[1] + b[1]) * cross;
  }
  return [cx / (6 * area), cz / (6 * area)];
}

/** Eje mayor del footprint + extensiones sobre ese eje (PCA de covarianza). */
function principalAxis(points: readonly V2[]): { c: V2; u: V2; halfU: number; halfV: number } {
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
  const u: V2 = [Math.cos(theta), Math.sin(theta)];
  const v: V2 = [-u[1], u[0]];
  let halfU = 0;
  let halfV = 0;
  for (const p of points) {
    const dx = p[0] - c[0];
    const dz = p[1] - c[1];
    halfU = Math.max(halfU, Math.abs(dx * u[0] + dz * u[1]));
    halfV = Math.max(halfV, Math.abs(dx * v[0] + dz * v[1]));
  }
  return { c, u, halfU, halfV };
}

/** Distancia de un punto a un poligono: 0 si cae dentro, si no al borde. */
function distanceToPolygon(points: readonly V2[], x: number, z: number): number {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const pi = points[i]!;
    const pj = points[j]!;
    if (pi[1] > z !== pj[1] > z && x < ((pj[0] - pi[0]) * (z - pi[1])) / (pj[1] - pi[1]) + pi[0]) {
      inside = !inside;
    }
  }
  if (inside) return 0;
  let best = Infinity;
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    const vx = b[0] - a[0];
    const vz = b[1] - a[1];
    const len2 = vx * vx + vz * vz;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((x - a[0]) * vx + (z - a[1]) * vz) / len2)) : 0;
    best = Math.min(best, Math.hypot(x - (a[0] + t * vx), z - (a[1] + t * vz)));
  }
  return best;
}

/** True si el poligono simple es convexo. Evita tejados a cuatro aguas plegados. */
function isConvexPolygon(points: readonly V2[]): boolean {
  const n = points.length;
  if (n < 4) return true;
  const ccw = signedArea(points) > 0;
  for (let i = 0; i < n; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % n]!;
    const c = points[(i + 2) % n]!;
    const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (ccw ? cross < -1e-9 : cross > 1e-9) return false;
  }
  return true;
}

function containsPoint(points: readonly V2[], x: number, z: number): boolean {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i]!;
    const b = points[j]!;
    if (a[1] > z !== b[1] > z && x < ((b[0] - a[0]) * (z - a[1])) / (b[1] - a[1]) + a[0]) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * El MDSnE mide la cubierta sobre el terreno. El juego dibuja muros hasta el
 * alero y añade su propia cumbrera, así que se resta el mismo ascenso del tejado
 * antes de sustituir la altura estimada por plantas.
 */
function lidarWallHeightM(
  building: Building,
  grid: BuildingHeightGrid,
  config: WorldTerrain['config'],
): number | null {
  if (building.heightSource === 'height') return null;
  const scale = config.worldScale;
  const e0 = config.bounds.e[0];
  const n0 = config.bounds.n[0];
  const points = building.footprint;
  const minE = e0 + Math.min(...points.map(([x]) => x / scale));
  const maxE = e0 + Math.max(...points.map(([x]) => x / scale));
  const minN = n0 + Math.min(...points.map(([, z]) => z / scale));
  const maxN = n0 + Math.max(...points.map(([, z]) => z / scale));
  const colMin = Math.max(0, Math.floor((minE - grid.topLeftEastingM) / grid.pixelSizeM));
  const colMax = Math.min(grid.width - 1, Math.floor((maxE - grid.topLeftEastingM) / grid.pixelSizeM));
  const rowMin = Math.max(0, Math.floor((grid.topLeftNorthingM - maxN) / grid.pixelSizeM));
  const rowMax = Math.min(grid.height - 1, Math.floor((grid.topLeftNorthingM - minN) / grid.pixelSizeM));
  if (colMin > colMax || rowMin > rowMax) return null;

  const samples: number[] = [];
  for (let row = rowMin; row <= rowMax; row++) {
    const z = (grid.topLeftNorthingM - (row + 0.5) * grid.pixelSizeM - n0) * scale;
    for (let col = colMin; col <= colMax; col++) {
      const index = row * grid.width + col;
      const heightM = grid.values[index]!;
      if (heightM <= 0) continue;
      const x = (grid.topLeftEastingM + (col + 0.5) * grid.pixelSizeM - e0) * scale;
      if (containsPoint(points, x, z)) samples.push(heightM);
    }
  }
  if (samples.length < MIN_LIDAR_SAMPLES) return null;
  samples.sort((a, b) => a - b);
  const roofHeightM = samples[Math.floor((samples.length - 1) * 0.95)]!;

  const axis = principalAxis(points);
  const gable = axis.halfV > 0.5 && axis.halfU / axis.halfV >= GABLE_ELONGATION;
  const roofRiseM = gable ? Math.min(Math.max(0.5 * axis.halfV, 0.4), 3) : 0;
  const wallHeightM = roofHeightM - roofRiseM;
  return wallHeightM >= MIN_LIDAR_WALL_HEIGHT_M && wallHeightM <= 60 ? wallHeightM : null;
}

/**
 * Triangulacion de un poligono simple por "ear clipping". Hace falta porque el
 * 62 % de los footprints de OSM NO son convexos (muescas, entrantes de patio):
 * un abanico desde el centro produciria triangulos superpuestos COPLANOS y eso
 * parpadea por z-fighting.
 */
function triangulatePolygon(points: readonly V2[]): number[] {
  const n = points.length;
  const ccw = signedArea(points) > 0;
  const remaining: number[] = [];
  for (let i = 0; i < n; i++) remaining.push(ccw ? i : n - 1 - i);
  const out: number[] = [];
  const isConvex = (a: number, b: number, c: number): boolean => {
    const pa = points[a]!;
    const pb = points[b]!;
    const pc = points[c]!;
    const cross = (pb[0] - pa[0]) * (pc[1] - pb[1]) - (pb[1] - pa[1]) * (pc[0] - pb[0]);
    return ccw ? cross > 1e-9 : cross < -1e-9;
  };
  const pointInTriangle = (p: number, a: number, b: number, c: number): boolean => {
    const pt = points[p]!;
    const pa = points[a]!;
    const pb = points[b]!;
    const pc = points[c]!;
    const d1 = (pt[0] - pb[0]) * (pa[1] - pb[1]) - (pa[0] - pb[0]) * (pt[1] - pb[1]);
    const d2 = (pt[0] - pc[0]) * (pb[1] - pc[1]) - (pb[0] - pc[0]) * (pt[1] - pc[1]);
    const d3 = (pt[0] - pa[0]) * (pc[1] - pa[1]) - (pc[0] - pa[0]) * (pt[1] - pa[1]);
    const neg = d1 < -1e-9 || d2 < -1e-9 || d3 < -1e-9;
    const pos = d1 > 1e-9 || d2 > 1e-9 || d3 > 1e-9;
    return !(neg && pos);
  };
  let guard = 0;
  const maxGuard = n * n + 16;
  while (remaining.length > 3 && guard < maxGuard) {
    guard++;
    let clipped = false;
    const size = remaining.length;
    for (let k = 0; k < size; k++) {
      const prev = remaining[(k + size - 1) % size]!;
      const cur = remaining[k]!;
      const next = remaining[(k + 1) % size]!;
      if (!isConvex(prev, cur, next)) continue;
      let blocked = false;
      for (const p of remaining) {
        if (p === prev || p === cur || p === next) continue;
        if (pointInTriangle(p, prev, cur, next)) {
          blocked = true;
          break;
        }
      }
      if (blocked) continue;
      out.push(prev, cur, next);
      remaining.splice(k, 1);
      clipped = true;
      break;
    }
    if (!clipped) break; // poligono degenerado: se sale y el techo queda a medias
  }
  if (remaining.length >= 3) {
    for (let k = 1; k < remaining.length - 1; k++) {
      out.push(remaining[0]!, remaining[k]!, remaining[k + 1]!);
    }
  }
  return out;
}

/* ------------------------------------------------------------------------- *
 * Buffers por grupo de material
 * ------------------------------------------------------------------------- */

interface GroupBuffers {
  readonly positions: number[];
  readonly normals: number[];
  readonly colors: number[];
  readonly indices: number[];
  triangles: number;
}

function emptyGroup(): GroupBuffers {
  return { positions: [], normals: [], colors: [], indices: [], triangles: 0 };
}

function pushVertex(g: GroupBuffers, x: number, y: number, z: number, nx: number, ny: number, nz: number): number {
  const index = g.positions.length / 3;
  g.positions.push(x, y, z);
  g.normals.push(nx, ny, nz);
  g.colors.push(1, 1, 1, 1);
  return index;
}

function tintVertices(g: GroupBuffers, firstVertex: number, tint: readonly [number, number, number]): void {
  for (let i = firstVertex * 4; i < g.colors.length; i += 4) {
    g.colors[i] = tint[0];
    g.colors[i + 1] = tint[1];
    g.colors[i + 2] = tint[2];
  }
}

function pushTri(g: GroupBuffers, a: number, b: number, c: number): void {
  g.indices.push(a, b, c);
  g.triangles++;
}

/**
 * Caras de tejado: la normal sale del propio triangulo y el winding se elige
 * para que apunte hacia ARRIBA (o, si la cara es casi vertical — los faldones
 * del hastial —, hacia afuera del centro). Sin esto, un tejado quedaria negro
 * por recibir la luz con la normal invertida.
 */
function pushRoofTriangle(
  g: GroupBuffers,
  a: readonly [number, number, number],
  b: readonly [number, number, number],
  c: readonly [number, number, number],
  center: V2,
): void {
  const ux = b[0] - a[0];
  const uy = b[1] - a[1];
  const uz = b[2] - a[2];
  const vx = c[0] - a[0];
  const vy = c[1] - a[1];
  const vz = c[2] - a[2];
  let nx = uy * vz - uz * vy;
  let ny = uz * vx - ux * vz;
  let nz = ux * vy - uy * vx;
  const length = Math.hypot(nx, ny, nz);
  if (length < 1e-9) return; // triangulo degenerado (costuras del hastial)
  const tcx = (a[0] + b[0] + c[0]) / 3;
  const tcz = (a[2] + b[2] + c[2]) / 3;
  const horizontalOut = (tcx - center[0]) * nx + (tcz - center[1]) * nz;
  const keep =
    Math.abs(ny) > 0.3 * length ? ny > 0 : horizontalOut > 0; // arriba, o hacia afuera
  if (!keep) {
    const swap = b;
    b = c;
    c = swap;
    nx = -nx;
    ny = -ny;
    nz = -nz;
  }
  const inv = 1 / length;
  const nnx = nx * inv;
  const nny = ny * inv;
  const nnz = nz * inv;
  const ia = pushVertex(g, a[0], a[1], a[2], nnx, nny, nnz);
  const ib = pushVertex(g, b[0], b[1], b[2], nnx, nny, nnz);
  const ic = pushVertex(g, c[0], c[1], c[2], nnx, nny, nnz);
  pushTri(g, ia, ib, ic);
}

/* ------------------------------------------------------------------------- *
 * Construccion de un edificio
 * ------------------------------------------------------------------------- */

/**
 * Franja de muro entre la base (`baseY`, el minimo del terreno menos el faldon)
 * y la linea de tejado de cada vertice (`topA`/`topB`). Cuatro vertices y dos
 * triangulos, con la normal EXTERIOR fija por arista `(dz, 0, -dx)`: las caras de
 * muro no necesitan el truco de orientacion del tejado porque su direccion la pone
 * el propio footprint (y el material tiene `backFaceCulling = false`, igual que
 * terreno y vias).
 *
 * Que el muro llegue hasta `topA`/`topB` y no hasta una linea plana es lo que
 * cierra los huecos en los entrantes de un footprint no convexo.
 */
function pushWallStrip(
  g: GroupBuffers,
  ax: number,
  az: number,
  bx: number,
  bz: number,
  baseY: number,
  topA: number,
  topB: number,
  nx: number,
  nz: number,
): void {
  const length = Math.hypot(nx, nz) || 1;
  const ux = nx / length;
  const uz = nz / length;
  const b0 = pushVertex(g, ax, baseY, az, ux, 0, uz);
  const b1 = pushVertex(g, bx, baseY, bz, ux, 0, uz);
  const t1 = pushVertex(g, bx, topB, bz, ux, 0, uz);
  const t0 = pushVertex(g, ax, topA, az, ux, 0, uz);
  pushTri(g, b0, b1, t1);
  pushTri(g, b0, t1, t0);
}

/**
 * Caja vertical sin tapas apoyada en `baseY`: lados girados `anguloLargoRad` (el eje
 * "largo" queda en la dirección (-sin, cos)). Alcanza para postes y travesaños, que se
 * ven desde fuera; no hace falta cerrar la tapa ni la base.
 */
function pushCaja(
  g: GroupBuffers,
  x: number,
  z: number,
  baseY: number,
  anchoM: number,
  largoM: number,
  altoM: number,
  anguloLargoRad: number,
): void {
  const c = Math.cos(anguloLargoRad);
  const sn = Math.sin(anguloLargoRad);
  const hw = anchoM / 2;
  const hl = largoM / 2;
  const corners: V2[] = [
    [x + c * hw + sn * hl, z - sn * hw + c * hl],
    [x - c * hw + sn * hl, z + sn * hw + c * hl],
    [x - c * hw - sn * hl, z + sn * hw - c * hl],
    [x + c * hw - sn * hl, z - sn * hw - c * hl],
  ];
  const top = baseY + altoM;
  for (let i = 0; i < 4; i++) {
    const a = corners[i]!;
    const b = corners[(i + 1) % 4]!;
    pushWallStrip(g, a[0], a[1], b[0], b[1], baseY, top, top, b[1] - a[1], a[0] - b[0]);
  }
}

/**
 * Cable fino entre dos puntos: dos cintas cruzadas, así se lee como línea desde
 * cualquier ángulo sin sumar un material de líneas ni otra llamada de dibujo.
 */
function pushAlambre(
  g: GroupBuffers,
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  grosorM: number,
): void {
  const dx = bx - ax;
  const dz = bz - az;
  const len = Math.hypot(dx, dz) || 1;
  const ux = dx / len;
  const uz = dz / len;
  const px = -uz * grosorM;
  const pz = ux * grosorM;
  const quad = (
    x0: number, y0: number, z0: number,
    x1: number, y1: number, z1: number,
    x2: number, y2: number, z2: number,
    x3: number, y3: number, z3: number,
    nx: number, ny: number, nz: number,
  ): void => {
    const i0 = pushVertex(g, x0, y0, z0, nx, ny, nz);
    const i1 = pushVertex(g, x1, y1, z1, nx, ny, nz);
    const i2 = pushVertex(g, x2, y2, z2, nx, ny, nz);
    const i3 = pushVertex(g, x3, y3, z3, nx, ny, nz);
    pushTri(g, i0, i1, i2);
    pushTri(g, i0, i2, i3);
  };
  // Cinta vertical.
  quad(ax, ay - grosorM, az, bx, by - grosorM, bz, bx, by + grosorM, bz, ax, ay + grosorM, az, px, 0.2, pz);
  // Cinta horizontal.
  quad(ax - px, ay, az - pz, bx - px, by, bz - pz, bx + px, by, bz + pz, ax + px, ay, az + pz, 0, 1, 0);
}

/**
 * Postes y cables de la calle del pueblo. Se apoyan en las muestras viarias que ya
 * recibe el módulo (nada nuevo que consultar) y van al lote de madera, así que no
 * suman malla ni llamada de dibujo. Alternan de lado para que los cables crucen la
 * calle en diagonal, como en un pueblo real.
 */
function buildStreetFurniture(ctx: BuildContext): number {
  const muestras = ctx.roadClearance.filter(
    (muestra) => muestra.radiusM >= 5 && muestra.dx !== undefined && muestra.dz !== undefined,
  );
  if (muestras.length < 6) return 0;

  const postes: { x: number; z: number; y: number; nx: number; nz: number }[] = [];
  let tramo: typeof muestras = [];
  // Se postea por DISTANCIA acumulada, no por índice: las muestras vienen a 1 m en las
  // vías con perfil de recorte y a 2,5 m en el resto.
  const PASO_POSTE_M = 28;
  const cerrarTramo = (): void => {
    let acumulado = PASO_POSTE_M * 0.5;
    let anterior: (typeof tramo)[number] | null = null;
    let indice = 0;
    for (const muestra of tramo) {
      if (anterior) acumulado += Math.hypot(muestra.x - anterior.x, muestra.z - anterior.z);
      anterior = muestra;
      if (acumulado < PASO_POSTE_M) continue;
      acumulado = 0;
      const lado = indice++ % 2 === 0 ? 1 : -1;
      const nx = -muestra.dz! * lado;
      const nz = muestra.dx! * lado;
      const lateral = Math.max(3.4, muestra.radiusM - 1.2);
      const x = muestra.x + nx * lateral;
      const z = muestra.z + nz * lateral;
      postes.push({ x, z, y: ctx.heightAt(x, z), nx, nz });
    }
    tramo = [];
  };
  for (const muestra of muestras) {
    const ultima = tramo[tramo.length - 1];
    if (ultima && Math.hypot(muestra.x - ultima.x, muestra.z - ultima.z) > 40) cerrarTramo();
    tramo.push(muestra);
  }
  cerrarTramo();

  const ALTO_POSTE_M = 7.4;
  const ALTURAS_CABLE_M = [6.9, 6.45];
  const FLECHA_M = 0.45;
  for (const poste of postes) {
    pushCaja(ctx.shutters, poste.x, poste.z, poste.y - 0.4, 0.18, 0.18, ALTO_POSTE_M, 0);
    // Travesaño perpendicular a la calle, en el extremo del poste.
    pushCaja(
      ctx.shutters,
      poste.x,
      poste.z,
      poste.y + ALTURAS_CABLE_M[0]! - 0.06,
      0.1,
      1.5,
      0.12,
      Math.atan2(-poste.nx, poste.nz),
    );
  }
  for (let i = 1; i < postes.length; i++) {
    const a = postes[i - 1]!;
    const b = postes[i]!;
    const span = Math.hypot(b.x - a.x, b.z - a.z);
    if (span > 40) continue;
    for (const altura of ALTURAS_CABLE_M) {
      const pasos = 3;
      for (let k = 0; k < pasos; k++) {
        const t0 = k / pasos;
        const t1 = (k + 1) / pasos;
        const caida = (t: number): number => Math.sin(Math.PI * t) * FLECHA_M;
        const y0 = a.y + altura + (b.y + altura - (a.y + altura)) * t0 - caida(t0);
        const y1 = a.y + altura + (b.y + altura - (a.y + altura)) * t1 - caida(t1);
        pushAlambre(
          ctx.shutters,
          a.x + (b.x - a.x) * t0, y0, a.z + (b.z - a.z) * t0,
          a.x + (b.x - a.x) * t1, y1, a.z + (b.z - a.z) * t1,
          0.045,
        );
      }
    }
  }
  return postes.length;
}

/**
 * Arista del footprint + su normal exterior unitaria. Misma convencion que
 * `pushWallStrip`; `i`/`j` permiten consultar la altura de tejado por vertice.
 */
interface Facade {
  readonly i: number;
  readonly j: number;
  readonly ax: number;
  readonly az: number;
  readonly bx: number;
  readonly bz: number;
  readonly ux: number;
  readonly uz: number;
  readonly len: number;
}

function facadeOf(a: V2, b: V2, ccw: boolean, i: number, j: number): Facade | null {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const len = Math.hypot(dx, dz);
  if (len < 1e-6) return null;
  const nx = ccw ? dz : -dz;
  const nz = ccw ? -dx : dx;
  const norm = Math.hypot(nx, nz) || 1;
  return { i, j, ax: a[0], az: a[1], bx: b[0], bz: b[1], ux: nx / norm, uz: nz / norm, len };
}

/**
 * Quad vertical pegado a la arista A->B, desplazado `out` metros hacia afuera
 * (normal `(ux, uz)`). `s0`/`s1` son distancias a lo largo de la arista desde A y
 * `y0`/`y1` alturas absolutas. Se usa para zocalo, huecos y faja del alero.
 */
function pushFacadeQuad(
  g: GroupBuffers,
  ax: number,
  az: number,
  bx: number,
  bz: number,
  ux: number,
  uz: number,
  out: number,
  s0: number,
  s1: number,
  y0: number,
  y1: number,
  endY0: number = y0,
  endY1: number = y1,
): void {
  const dx = bx - ax;
  const dz = bz - az;
  const len = Math.hypot(dx, dz);
  if (len < 1e-6 || s1 - s0 < 1e-3 || y1 - y0 < 1e-3 || endY1 - endY0 < 1e-3) return;
  const ex = dx / len;
  const ez = dz / len;
  const xAt = (s: number): number => ax + ex * s + ux * out;
  const zAt = (s: number): number => az + ez * s + uz * out;
  const i0 = pushVertex(g, xAt(s0), y0, zAt(s0), ux, 0, uz);
  const i1 = pushVertex(g, xAt(s1), endY0, zAt(s1), ux, 0, uz);
  const i2 = pushVertex(g, xAt(s1), endY1, zAt(s1), ux, 0, uz);
  const i3 = pushVertex(g, xAt(s0), y1, zAt(s0), ux, 0, uz);
  pushTri(g, i0, i1, i2);
  pushTri(g, i0, i2, i3);
}

interface BuildContext {
  readonly heightAt: (x: number, z: number) => number;
  /**
   * Muestras del eje viario cercanas al spawn, para orientar ventanas a la calle y
   * clavar postes. `dx`/`dz` es la dirección del eje (opcional: sin ella no se postea).
   */
  readonly roadClearance: readonly {
    readonly x: number;
    readonly z: number;
    readonly radiusM: number;
    readonly dx?: number;
    readonly dz?: number;
  }[];
  readonly bodies: Record<BodyKind, GroupBuffers>;
  readonly roofs: Record<RoofKind, GroupBuffers>;
  /** Huecos (puerta/ventana) y zocalo: los dos lotes extra, solo cerca del spawn. */
  readonly details: GroupBuffers;
  readonly plinths: GroupBuffers;
  readonly shutters: GroupBuffers;
  /** Centro de detalle (spawn): radio de aplicacion y radio que no se invade. */
  readonly detail: {
    readonly x: number;
    readonly z: number;
    readonly radiusM: number;
    readonly clearRadiusM: number;
  } | null;
}

/** Construye muros + tejado de UN edificio dentro de los buffers de su grupo. */
function buildBuilding(ctx: BuildContext, building: Building, detailed: boolean, facadeFocus: FacadeRoutePoint | null): void {
  const points = building.footprint;
  const n = points.length;

  // LA base: minimo terrain.heightAt del footprint. De ahi el faldon hacia abajo
  // y la altura del edificio hacia arriba. Nada de y precalculada en el JSON.
  let minY = Infinity;
  for (const [x, z] of points) {
    const y = ctx.heightAt(x, z);
    if (y < minY) minY = y;
  }
  const baseY = minY - FALDON_M;
  const topY = minY + building.heightM;

  const body = ctx.bodies[building.materialKind];
  const roof = ctx.roofs[building.roofKind];
  const bodyFirstVertex = body.positions.length / 3;
  const roofFirstVertex = roof.positions.length / 3;
  const roofTint = buildingRoofTint(building.id);

  const axis = principalAxis(points);
  const elongation = axis.halfV > 0.5 ? axis.halfU / axis.halfV : 0;
  const elongated = elongation >= GABLE_ELONGATION && axis.halfV > 0.5;
  // Forma de la cubierta independiente del LOD de fachadas. La cumbrera se
  // mantiene en `topY` y los aleros bajan, así que la altura LiDAR no cambia.
  const areaM2 = Math.abs(signedArea(points));
  // Cuatro aguas: la superficie va en abanico a la cumbrera, asi que exige planta
  // convexa y sencilla; en un footprint con entrantes se plegaria sobre si misma.
  const safeHip = n <= 8 && areaM2 <= 800 && isConvexPolygon(points);
  // Un agua: la superficie se triangula con ear clipping igual que el tejado
  // plano, de modo que es segura tambien en plantas no convexas; solo se limita
  // el tamano para que un unico faldon no cruce un edificio complejo.
  const safeShed = n <= 16 && areaM2 <= 1000;
  const shape = selectRoofShape({
    elongated,
    hipAllowed: safeHip,
    shedAllowed: safeShed,
    variant: hash32(building.id) % 4,
  });
  const gable = shape === 'gable';
  // Puntas del tejado: crecen con el ancho y estan limitadas para que ningun
  // edificio se dispare (una nave de 30 m no lleva un fronton de 8 m).
  const rise = gable ? Math.min(Math.max(0.25 * (2 * axis.halfV), 0.4), 3) : 0;
  // Cuanto baja el alero respecto a `topY`; la cumbrera (o el alero alto) queda
  // siempre en `topY` para no alterar la altura maxima medida.
  const hipDrop = shape === 'hip' ? Math.min(Math.max(0.45 * Math.min(axis.halfU, axis.halfV), 0.5), HIP_MAX_DROP_M) : 0;
  const shedDrop = shape === 'shed' ? Math.min(Math.max(0.35 * axis.halfV, 0.4), SHED_MAX_DROP_M) : 0;
  // Longitud media de la cumbrera: en cuatro aguas se recorta en los testeros.
  const ridgeHalfU = shape === 'hip' ? Math.max(0, axis.halfU - axis.halfV) : axis.halfU;

  // Altura del tejado POR VERTICE. Con tejado plano es `topY` para todos; con
  // dos aguas sube linealmente desde los aleros hasta la cumbrera, lo que deja
  // los muros sin agujeros en los entrantes del footprint.
  const roofY: number[] = [];
  const projU: number[] = [];
  for (const [x, z] of points) {
    const dx = x - axis.c[0];
    const dz = z - axis.c[1];
    const u = dx * axis.u[0] + dz * axis.u[1];
    const v = dx * -axis.u[1] + dz * axis.u[0]; // componente sobre el eje corto
    projU.push(u);
    let y = topY;
    if (gable) {
      y = topY + rise * (1 - Math.min(1, Math.abs(v) / axis.halfV));
    } else if (shape === 'hip') {
      // Distancia adimensional al borde: 0 en la cumbrera, 1 en el alero. El
      // max() de las dos direcciones da el quiebro de las cuatro aguas; si la
      // planta es cuadrada la cumbrera degenera en un vertice.
      const dShort = Math.abs(v) / Math.max(axis.halfV, 1e-3);
      const dLong = ridgeHalfU > 1e-3 ? Math.max(0, Math.abs(u) - ridgeHalfU) / Math.max(axis.halfV, 1e-3) : 0;
      y = topY - hipDrop * Math.min(1, Math.max(dShort, dLong));
    } else if (shape === 'shed') {
      // Faldon unico: sube del alero bajo (-halfV) al alto (+halfV), tope en topY.
      const t = Math.min(1, Math.max(0, (v + axis.halfV) / Math.max(2 * axis.halfV, 1e-3)));
      y = topY - shedDrop * (1 - t);
    }
    roofY.push(y);
  }

  const ccw = signedArea(points) > 0;
  const ridgeSpan = Math.max(1e-6, 2 * axis.halfU);
  const clampRidgeU = (u: number): number => (u < -ridgeHalfU ? -ridgeHalfU : u > ridgeHalfU ? ridgeHalfU : u);

  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const a = points[i]!;
    const b = points[j]!;
    // Normal exterior: (dz, -dx) si el recorrido es antihorario, lo contrario si no.
    const edgeNx = ccw ? b[1] - a[1] : -(b[1] - a[1]);
    const edgeNz = ccw ? -(b[0] - a[0]) : b[0] - a[0];
    const topA = roofY[i]!;
    const topB = roofY[j]!;

    // Muro: de la base (min del terreno - faldon) hasta la linea de tejado.
    pushWallStrip(body, a[0], a[1], b[0], b[1], baseY, topA, topB, edgeNx, edgeNz);

    if (shape === 'flat' || shape === 'shed') continue;

    const isEndEdge = Math.abs(projU[i]! - projU[j]!) <= 0.05 * ridgeSpan;

    if (gable) {
      const uMid = (projU[i]! + projU[j]!) / 2;
      const ridgeX = axis.c[0] + axis.u[0] * uMid;
      const ridgeZ = axis.c[1] + axis.u[1] * uMid;
      const ridgeY = topY + rise;
      if (isEndEdge) {
        // Hastial: el triangulo vertical cierra el techo por los extremos y lleva
        // la normal del muro, porque es continuation de la pared.
        pushWallTriangle(body, a[0], topA, a[1], b[0], topB, b[1], ridgeX, ridgeY, ridgeZ, edgeNx, edgeNz);
      } else {
        // Dos aguas: cuadrilatero desde el alero hasta la cumbrera.
        const rA = [axis.c[0] + axis.u[0] * projU[i]!, ridgeY, axis.c[1] + axis.u[1] * projU[i]!] as const;
        const rB = [axis.c[0] + axis.u[0] * projU[j]!, ridgeY, axis.c[1] + axis.u[1] * projU[j]!] as const;
        const pa = [a[0], topA, a[1]] as const;
        const pb = [b[0], topB, b[1]] as const;
        pushRoofTriangle(roof, pa, pb, rB, axis.c);
        pushRoofTriangle(roof, pa, rB, rA, axis.c);
      }
      continue;
    }

    // Cuatro aguas: cada arista sube hasta la cumbrera recortada. En los testeros
    // los dos extremos caen en el mismo punto y sale un triangulo de faldon.
    const cuA = clampRidgeU(projU[i]!);
    const cuB = clampRidgeU(projU[j]!);
    const rA = [axis.c[0] + axis.u[0] * cuA, topY, axis.c[1] + axis.u[1] * cuA] as const;
    const rB = [axis.c[0] + axis.u[0] * cuB, topY, axis.c[1] + axis.u[1] * cuB] as const;
    const pa = [a[0], topA, a[1]] as const;
    const pb = [b[0], topB, b[1]] as const;
    pushRoofTriangle(roof, pa, pb, rB, axis.c);
    pushRoofTriangle(roof, pa, rB, rA, axis.c);
  }

  tintVertices(body, bodyFirstVertex, buildingTint(building.id));

  if (shape === 'flat' || shape === 'shed') {
    // Tejado plano o faldon unico: tapa el poligono completo a la altura de cada
    // vertice. En plano `roofY` es constante; en un agua forma una pendiente.
    const indices = triangulatePolygon(points);
    for (let k = 0; k < indices.length; k += 3) {
      const ia = indices[k]!;
      const ib = indices[k + 1]!;
      const ic = indices[k + 2]!;
      pushRoofTriangle(
        roof,
        [points[ia]![0], roofY[ia]!, points[ia]![1]],
        [points[ib]![0], roofY[ib]!, points[ib]![1]],
        [points[ic]![0], roofY[ic]!, points[ic]![1]],
        axis.c,
      );
    }
  }

  tintVertices(roof, roofFirstVertex, roofTint);

  const pilotStyle = VILLAGE_PILOT_HOUSES[building.id] ?? (detailed ? selectVillageFacadeKit(building.id) : undefined);
  if (detailed && pilotStyle?.tileCourses && gable && building.roofKind === 'teja') {
    buildRoofTileCourses(roof, points, axis, topY, rise, roofTint);
  }

  if (detailed) {
    // Variante de fachada determinista: porton de cuadra, ritmo tupido (por
    // defecto) o una sola ventana alta por planta (muro mas rural y ciego).
    const variant = hash32(building.id) % 3;
    const eaveFirstVertex = roof.positions.length / 3;
    buildFacadeDetails(ctx, points, {
      ccw, gable, ridgeSpan, roofY, projU, axis, minY, baseY, roof,
      shutters: (pilotStyle?.shutters ?? (pilotStyle ? true : building.id % 2 === 0)) ? ctx.shutters : null,
      porton: pilotStyle?.porton ?? variant === 0,
      sparseWindows: pilotStyle?.sparseWindows ?? variant === 2,
      pilotStyle,
      facadeFocus,
    });
    tintVertices(roof, eaveFirstVertex, roofTint);
    if ((gable || shape === 'hip') && n <= 8 && (pilotStyle?.chimney ?? hash32(building.id) % 2 === 0) &&
        Math.abs(signedArea(points)) >= 35 && axis.halfU >= 2) {
      // Chimeneas de ladrillo/piedra en una parte de las casas próximas. La base
      // se mete en la cumbrera; la posición queda dentro del footprint y la tapa
      // sobresale lo justo para que la silueta se lea a media distancia.
      const along = ridgeHalfU > 0.8 ? ridgeHalfU * 0.48 : 0;
      const cx = axis.c[0] + axis.u[0] * along;
      const cz = axis.c[1] + axis.u[1] * along;
      if (distanceToPolygon(points, cx, cz) > 0) return;
      const v: V2 = [-axis.u[1], axis.u[0]];
      const corners: V2[] = [
        [cx - axis.u[0] * 0.3 - v[0] * 0.25, cz - axis.u[1] * 0.3 - v[1] * 0.25],
        [cx + axis.u[0] * 0.3 - v[0] * 0.25, cz + axis.u[1] * 0.3 - v[1] * 0.25],
        [cx + axis.u[0] * 0.3 + v[0] * 0.25, cz + axis.u[1] * 0.3 + v[1] * 0.25],
        [cx - axis.u[0] * 0.3 + v[0] * 0.25, cz - axis.u[1] * 0.3 + v[1] * 0.25],
      ];
      if (corners.some((corner) => distanceToPolygon(points, corner[0], corner[1]) > 0)) return;
      const ridgeY = gable ? topY + rise : topY;
      const bottom = ridgeY - 0.28;
      const top = ridgeY + 1.4;
      for (let i = 0; i < 4; i++) {
        const a = corners[i]!;
        const b = corners[(i + 1) % 4]!;
        pushWallStrip(ctx.plinths, a[0], a[1], b[0], b[1], bottom, top, top, b[1] - a[1], a[0] - b[0]);
      }
      pushRoofTriangle(ctx.plinths, [corners[0]![0], top, corners[0]![1]], [corners[1]![0], top, corners[1]![1]], [corners[2]![0], top, corners[2]![1]], axis.c);
      pushRoofTriangle(ctx.plinths, [corners[0]![0], top, corners[0]![1]], [corners[2]![0], top, corners[2]![1]], [corners[3]![0], top, corners[3]![1]], axis.c);

      // Tapa perimetral de piedra para que el conducto no termine como un bloque cortado.
      const capCorners: V2[] = [
        [cx - axis.u[0] * 0.37 - v[0] * 0.32, cz - axis.u[1] * 0.37 - v[1] * 0.32],
        [cx + axis.u[0] * 0.37 - v[0] * 0.32, cz + axis.u[1] * 0.37 - v[1] * 0.32],
        [cx + axis.u[0] * 0.37 + v[0] * 0.32, cz + axis.u[1] * 0.37 + v[1] * 0.32],
        [cx - axis.u[0] * 0.37 + v[0] * 0.32, cz - axis.u[1] * 0.37 + v[1] * 0.32],
      ];
      const capY = top + 0.12;
      for (let i = 0; i < 4; i++) {
        const a = capCorners[i]!;
        const b = capCorners[(i + 1) % 4]!;
        pushWallStrip(ctx.plinths, a[0], a[1], b[0], b[1], top, capY, capY, b[1] - a[1], a[0] - b[0]);
      }
      pushRoofTriangle(ctx.plinths, [capCorners[0]![0], capY, capCorners[0]![1]], [capCorners[1]![0], capY, capCorners[1]![1]], [capCorners[2]![0], capY, capCorners[2]![1]], axis.c);
      pushRoofTriangle(ctx.plinths, [capCorners[0]![0], capY, capCorners[0]![1]], [capCorners[2]![0], capY, capCorners[2]![1]], [capCorners[3]![0], capY, capCorners[3]![1]], axis.c);
    }
  }
}

/**
 * Add fine, darkened tile courses to selected nearby gable roofs. The strips are
 * written into the existing roof material buffer, so they add geometry without
 * adding a mesh or draw call. Their ends follow the actual OSM polygon section;
 * irregular gables therefore cannot grow stripes past their roof silhouette.
 */
function buildRoofTileCourses(
  roof: GroupBuffers,
  points: readonly V2[],
  axis: { readonly c: V2; readonly u: V2; readonly halfU: number; readonly halfV: number },
  topY: number,
  rise: number,
  tint: readonly [number, number, number],
): void {
  if (axis.halfU < 1.5 || axis.halfV < 0.8 || rise <= 0 || !isConvexPolygon(points)) return;

  const projected = points.map(([x, z]) => {
    const dx = x - axis.c[0];
    const dz = z - axis.c[1];
    return {
      u: dx * axis.u[0] + dz * axis.u[1],
      v: dx * -axis.u[1] + dz * axis.u[0],
    };
  });
  const sideExtentAt = (u: number, side: -1 | 1): number | null => {
    const crossings: number[] = [];
    for (let i = 0; i < projected.length; i++) {
      const a = projected[i]!;
      const b = projected[(i + 1) % projected.length]!;
      const du = b.u - a.u;
      if (Math.abs(du) < 1e-6) {
        if (Math.abs(u - a.u) < 1e-5) crossings.push(a.v, b.v);
        continue;
      }
      const t = (u - a.u) / du;
      if (t >= -1e-6 && t <= 1 + 1e-6) crossings.push(a.v + (b.v - a.v) * t);
    }
    if (crossings.length === 0) return null;
    return side > 0 ? Math.max(...crossings) : Math.min(...crossings);
  };
  const pointAt = (u: number, v: number): readonly [number, number, number] => [
    axis.c[0] + axis.u[0] * u - axis.u[1] * v,
    topY + rise * (1 - Math.min(1, Math.abs(v) / axis.halfV)) + 0.018,
    axis.c[1] + axis.u[1] * u + axis.u[0] * v,
  ];
  const halfBandM = 0.035;
  const endMarginM = Math.min(0.45, axis.halfU * 0.16);
  const span = Math.max(0, axis.halfU * 2 - endMarginM * 2);
  const count = Math.min(28, Math.max(3, Math.ceil(span / 0.82)));
  const step = span / (count - 1);
  const firstVertex = roof.positions.length / 3;

  for (const side of [-1, 1] as const) {
    for (let index = 0; index < count; index++) {
      const u = -axis.halfU + endMarginM + index * step;
      const u0 = Math.max(-axis.halfU, u - halfBandM);
      const u1 = Math.min(axis.halfU, u + halfBandM);
      const edge0 = sideExtentAt(u0, side);
      const edge1 = sideExtentAt(u1, side);
      if (edge0 === null || edge1 === null) continue;
      const v0 = edge0 - side * 0.08;
      const v1 = edge1 - side * 0.08;
      if (Math.abs(v0) < 0.12 || Math.abs(v1) < 0.12) continue;
      const a = pointAt(u0, side * 0.08);
      const b = pointAt(u1, side * 0.08);
      const c = pointAt(u1, v1);
      const d = pointAt(u0, v0);
      pushRoofTriangle(roof, a, b, c, axis.c);
      pushRoofTriangle(roof, a, c, d, axis.c);
    }
  }

  tintVertices(roof, firstVertex, [tint[0] * 0.78, tint[1] * 0.75, tint[2] * 0.73]);
}

/** Contexto de detalle que `buildBuilding` ya calculo y no queremos repetir. */
interface FacadeDetailContext {
  readonly ccw: boolean;
  readonly gable: boolean;
  readonly ridgeSpan: number;
  readonly roofY: readonly number[];
  readonly projU: readonly number[];
  readonly axis: { readonly c: V2; readonly u: V2; readonly halfU: number; readonly halfV: number };
  readonly minY: number;
  readonly baseY: number;
  readonly roof: GroupBuffers;
  readonly shutters: GroupBuffers | null;
  /** Porton ancho de cuadra en la fachada principal (madera). */
  readonly porton: boolean;
  /** Ritmo rural: una sola ventana por planta en lugar de dos. */
  readonly sparseWindows: boolean;
  /** Selected pilot façades may use a small, stylized stone corner return. */
  readonly pilotStyle: VillagePilotHouseStyle | undefined;
  readonly facadeFocus: FacadeRoutePoint | null;
}

/**
 * Detalle de fachada de una casa cercana al spawn: zocalo, puerta, ventanas y
 * alero. Determinista (solo geometria), sin invadir el despeje del spawn. Los
 * huecos y el zocalo van a sus lotes; el alero reutiliza el material del techo.
 */
function buildFacadeDetails(ctx: BuildContext, points: readonly V2[], detailCtx: FacadeDetailContext): void {
  const detail = ctx.detail;
  const focus = detailCtx.facadeFocus ?? detail;
  if (!focus) return;
  const { ccw, gable, ridgeSpan, roofY, projU, axis, minY, baseY, roof, shutters, porton, sparseWindows, pilotStyle } = detailCtx;
  const n = points.length;
  // Keep the existing buried base, but follow the actual terrain along each
  // facade instead of losing the stone band on the uphill side of a house.
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const facade = facadeOf(points[i]!, points[j]!, ccw, i, j);
    if (!facade) continue;
    const segments = Math.max(1, Math.ceil(facade.len / 2));
    const topAtGround = (s: number): number => {
      const t = s / facade.len;
      const x = facade.ax + (facade.bx - facade.ax) * t + facade.ux * PLINTH_OUT_M;
      const z = facade.az + (facade.bz - facade.az) * t + facade.uz * PLINTH_OUT_M;
      const eave = roofY[i]! + (roofY[j]! - roofY[i]!) * t;
      return Math.min(ctx.heightAt(x, z) + PLINTH_HEIGHT_M, eave - 0.2);
    };
    for (let segment = 0; segment < segments; segment++) {
      const s0 = facade.len * segment / segments;
      const s1 = facade.len * (segment + 1) / segments;
      pushFacadeQuad(ctx.plinths, facade.ax, facade.az, facade.bx, facade.bz,
        facade.ux, facade.uz, PLINTH_OUT_M, s0, s1,
        baseY, topAtGround(s0), baseY, topAtGround(s1));
    }
  }

  // 2. Huecos: puerta en la fachada principal y ventanas en las dos primeras.
  const facades: Facade[] = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const facade = facadeOf(points[i]!, points[j]!, ccw, i, j);
    if (facade && facade.len >= MIN_FACADE_M) facades.push(facade);
  }
  facades.sort((left, right) => right.len - left.len);

  const clear = (x: number, z: number): boolean =>
    !detail || Math.hypot(x - detail.x, z - detail.z) >= detail.clearRadiusM;
  const pointOn = (facade: Facade, s: number, out: number): { x: number; z: number } => {
    const ex = (facade.bx - facade.ax) / facade.len;
    const ez = (facade.bz - facade.az) / facade.len;
    return { x: facade.ax + ex * s + facade.ux * out, z: facade.az + ez * s + facade.uz * out };
  };
  const topAt = (facade: Facade, s: number): number => {
    const t = facade.len > 0 ? s / facade.len : 0;
    return roofY[facade.i]! + (roofY[facade.j]! - roofY[facade.i]!) * t;
  };

  // La fachada principal es la mas larga que MIRA al spawn (es la que se ve desde
  // la aparicion); si ninguna mira, la mas larga. Determinista.
  const facingSpawn = (facade: Facade): number => {
    const mx = (facade.ax + facade.bx) / 2;
    const mz = (facade.az + facade.bz) / 2;
    const vx = focus.x - mx;
    const vz = focus.z - mz;
    const norm = Math.hypot(vx, vz) || 1;
    return (facade.ux * vx + facade.uz * vz) / norm;
  };
  const roadFacing = (facade: Facade): number => {
    const mx = (facade.ax + facade.bx) / 2;
    const mz = (facade.az + facade.bz) / 2;
    let best = 0;
    for (const road of ctx.roadClearance) {
      const vx = road.x - mx;
      const vz = road.z - mz;
      const distance = Math.hypot(vx, vz) || 1;
      const facing = (facade.ux * vx + facade.uz * vz) / distance;
      // La fachada debe mirar hacia un eje vial próximo. La atenuación por
      // distancia evita decorar los patios interiores sólo por una carretera lejana.
      const exposure = facing * Math.max(0, 1 - Math.max(0, distance - road.radiusM) / 24);
      best = Math.max(best, exposure);
    }
    return best;
  };
  const bestFacing = [...facades].sort((left, right) =>
    facingSpawn(right) - facingSpawn(left) || roadFacing(right) - roadFacing(left) || right.len - left.len,
  )[0];
  const main = bestFacing && facingSpawn(bestFacing) > 0.3 ? bestFacing : facades[0];
  let doorInterval: readonly [number, number] | null = null;
  if (main && pilotStyle?.stoneReturns && main.len >= 4.2) {
    const edgeWidthM = 0.22;
    const topStart = topAt(main, edgeWidthM);
    const topEnd = topAt(main, main.len - edgeWidthM);
    pushFacadeQuad(ctx.plinths, main.ax, main.az, main.bx, main.bz, main.ux, main.uz,
      WINDOW_TRIM_OUT_M, 0.03, edgeWidthM, baseY, topStart);
    pushFacadeQuad(ctx.plinths, main.ax, main.az, main.bx, main.bz, main.ux, main.uz,
      WINDOW_TRIM_OUT_M, main.len - edgeWidthM, main.len - 0.03, baseY, topEnd);
  }
  if (main) {
    const doorWidth = porton ? PORTON_WIDTH_M : DOOR_WIDTH_M;
    const minDoorCenter = Math.min(main.len / 2, doorWidth / 2 + 0.08);
    const maxDoorCenter = Math.max(main.len / 2, main.len - doorWidth / 2 - 0.08);
    const edgeX = (main.bx - main.ax) / main.len;
    const edgeZ = (main.bz - main.az) / main.len;
    const projectedRouteS = (focus.x - main.ax) * edgeX + (focus.z - main.az) * edgeZ;
    const preferredS = Math.max(minDoorCenter, Math.min(maxDoorCenter, projectedRouteS));
    const doorHeight = porton ? PORTON_HEIGHT_M : DOOR_HEIGHT_M;
    const thresholdY = (position: number): number => {
      const point = pointOn(main, position, 0);
      return ctx.heightAt(point.x, point.z) + 0.03;
    };
    const fitsDoor = (center: number): boolean => {
      const halfWidth = doorWidth / 2;
      const y0 = Math.max(thresholdY(center - halfWidth), thresholdY(center + halfWidth));
      return y0 + doorHeight <= topAt(main, center) - 0.1;
    };
    const count = Math.max(1, Math.ceil((maxDoorCenter - minDoorCenter) / 0.25));
    const candidates = Array.from({ length: count + 1 }, (_, i) => minDoorCenter +
      (maxDoorCenter - minDoorCenter) * i / count)
      .sort((left, right) => Math.abs(left - preferredS) - Math.abs(right - preferredS));
    const s = candidates.find(fitsDoor);
    if (s !== undefined) {
      const s0 = s - doorWidth / 2;
      const s1 = s + doorWidth / 2;
      const out = pointOn(main, s, OPENING_OUT_M);
      // Entrance sits at the nearest point to the route that still has enough
      // headroom below the eave, so sloped roofs do not suppress the doorway.
      const leftGroundY = thresholdY(s0);
      const rightGroundY = thresholdY(s1);
      const y0 = Math.max(leftGroundY, rightGroundY);
      const y1 = y0 + doorHeight;
      if (clear(out.x, out.z)) {
      if (porton) {
        pushFacadeQuad(ctx.shutters, main.ax, main.az, main.bx, main.bz, main.ux, main.uz,
          OPENING_OUT_M, s0, s1, y0, y1);
      } else {
        pushFacadeQuad(ctx.details, main.ax, main.az, main.bx, main.bz, main.ux, main.uz,
          OPENING_OUT_M, s0, s1, y0, y1);
      }
      // Frame and sill follow the same ground slope as the door, avoiding a
      // floating corner or a buried edge when the entrance crosses a DEM slope.
      pushFacadeQuad(ctx.plinths, main.ax, main.az, main.bx, main.bz, main.ux, main.uz,
        WINDOW_TRIM_OUT_M, s0 - 0.1, s0 - 0.025, y0, y1 + 0.05);
      pushFacadeQuad(ctx.plinths, main.ax, main.az, main.bx, main.bz, main.ux, main.uz,
        WINDOW_TRIM_OUT_M, s1 + 0.025, s1 + 0.1, y0, y1 + 0.05);
      pushFacadeQuad(ctx.plinths, main.ax, main.az, main.bx, main.bz, main.ux, main.uz,
        WINDOW_TRIM_OUT_M, s0 - 0.1, s1 + 0.1,
        leftGroundY - 0.05, y0 + 0.02, rightGroundY - 0.05, y0 + 0.02);
      if (y1 + 0.14 < topAt(main, s)) {
        pushFacadeQuad(ctx.plinths, main.ax, main.az, main.bx, main.bz, main.ux, main.uz,
          WINDOW_TRIM_OUT_M, s0 - 0.12, s1 + 0.12, y1 + 0.04, y1 + 0.14);
      }
      doorInterval = [s0, s1];
      }
    }
  }

  const addWindow = (facade: Facade, s: number, floor: number): void => {
    const s0 = s - WINDOW_WIDTH_M / 2;
    const s1 = s + WINDOW_WIDTH_M / 2;
    if (s0 < 0.15 || s1 > facade.len - 0.15) return;
    if (floor === 0 && facade === main && doorInterval && s0 < doorInterval[1] && s1 > doorInterval[0]) return;
    const out = pointOn(facade, s, OPENING_OUT_M);
    if (!clear(out.x, out.z)) return;
    const ground = pointOn(facade, s, 0);
    // Alinear las ventanas del mismo piso sobre un datum común evita el efecto
    // escalonado en fachadas que cruzan una ladera. Se omiten las enterradas.
    const y0 = minY + WINDOW_SILL_M + floor * 3;
    const y1 = y0 + WINDOW_HEIGHT_M;
    if (ctx.heightAt(ground.x, ground.z) > y0 - 0.15) return;
    if (y1 > topAt(facade, s) - 0.1) return;
    pushFacadeQuad(ctx.details, facade.ax, facade.az, facade.bx, facade.bz, facade.ux, facade.uz, OPENING_OUT_M, s0, s1, y0, y1);
    pushFacadeQuad(ctx.plinths, facade.ax, facade.az, facade.bx, facade.bz, facade.ux, facade.uz, WINDOW_TRIM_OUT_M, s0 - 0.09, s0 - 0.02, y0 - 0.04, y1 + 0.04);
    pushFacadeQuad(ctx.plinths, facade.ax, facade.az, facade.bx, facade.bz, facade.ux, facade.uz, WINDOW_TRIM_OUT_M, s1 + 0.02, s1 + 0.09, y0 - 0.04, y1 + 0.04);
    pushFacadeQuad(ctx.plinths, facade.ax, facade.az, facade.bx, facade.bz, facade.ux, facade.uz, WINDOW_TRIM_OUT_M, s0 - 0.09, s1 + 0.09, y0 - 0.11, y0 - 0.04);
    if (y1 + 0.12 < topAt(facade, s)) {
      pushFacadeQuad(ctx.plinths, facade.ax, facade.az, facade.bx, facade.bz, facade.ux, facade.uz, WINDOW_TRIM_OUT_M, s0 - 0.06, s1 + 0.06, y1 + 0.04, y1 + 0.12);
    }
    if (shutters && s0 >= SHUTTER_WIDTH_M + SHUTTER_GAP_M + 0.15 &&
        s1 <= facade.len - SHUTTER_WIDTH_M - SHUTTER_GAP_M - 0.15) {
      const shutterY0 = y0 - 0.015;
      const shutterY1 = Math.min(y1 + 0.015, topAt(facade, s) - 0.12);
      if (shutterY1 > shutterY0) {
        pushFacadeQuad(
          shutters, facade.ax, facade.az, facade.bx, facade.bz, facade.ux, facade.uz,
          SHUTTER_OUT_M, s0 - SHUTTER_GAP_M - SHUTTER_WIDTH_M, s0 - SHUTTER_GAP_M,
          shutterY0, shutterY1,
        );
        pushFacadeQuad(
          shutters, facade.ax, facade.az, facade.bx, facade.bz, facade.ux, facade.uz,
          SHUTTER_OUT_M, s1 + SHUTTER_GAP_M, s1 + SHUTTER_GAP_M + SHUTTER_WIDTH_M,
          shutterY0, shutterY1,
        );
      }
    }
  };

  // La puerta y el vano seleccionados priorizan la fachada hacia el vial próximo;
  // las ventanas usan además la exposición de cada frente a la calle.
  const ordered = facades
    .filter((facade) => facade !== main)
    .sort((left, right) => roadFacing(right) - roadFacing(left) || right.len - left.len);
  const windowFacades = main ? [main, ...ordered.slice(0, 2)] : ordered.slice(0, 3);
  for (const facade of windowFacades) {
    for (let floor = 0; floor < 3; floor++) {
      if (facade.len >= 3.2 && !sparseWindows) {
        addWindow(facade, facade.len * 0.2, floor);
        addWindow(facade, facade.len * 0.8, floor);
      } else {
        addWindow(facade, facade.len * 0.5, floor);
      }
    }
  }

  // 3. Alero: vuelo horizontal + faja de canto. No toca los hastiales y reutiliza
  //    el material del tejado, asi que no suma lotes.
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const facade = facadeOf(points[i]!, points[j]!, ccw, i, j);
    if (!facade || facade.len < 1) continue;
    if (gable && Math.abs(projU[i]! - projU[j]!) <= 0.05 * ridgeSpan) continue;
    const topA = roofY[i]!;
    const topB = roofY[j]!;
    const overhangM = constrainEaveOverhang(
      {
        ax: facade.ax,
        az: facade.az,
        bx: facade.bx,
        bz: facade.bz,
        nx: facade.ux,
        nz: facade.uz,
      },
      ctx.roadClearance,
      EAVE_OVERHANG_M,
      EAVE_ROAD_GAP_M,
    );
    const oax = facade.ax + facade.ux * overhangM;
    const oaz = facade.az + facade.uz * overhangM;
    const obx = facade.bx + facade.ux * overhangM;
    const obz = facade.bz + facade.uz * overhangM;
    pushRoofTriangle(roof, [facade.ax, topA, facade.az], [facade.bx, topB, facade.bz], [obx, topB, obz], axis.c);
    pushRoofTriangle(roof, [facade.ax, topA, facade.az], [obx, topB, obz], [oax, topA, oaz], axis.c);
    pushFacadeQuad(
      roof, oax, oaz, obx, obz, facade.ux, facade.uz, 0, 0, facade.len,
      topA - EAVE_FASCIA_M, topA, topB - EAVE_FASCIA_M, topB,
    );
  }
}

interface MappedWall {
  readonly id: number;
  readonly points: readonly V2[];
  readonly heightM: number;
  readonly widthM: number;
}

/** Only OSM barrier lines: no decorative offsets from house footprints. */
function buildMappedWalls(group: GroupBuffers, walls: readonly MappedWall[], heightAt: (x: number, z: number) => number): number {
  for (const wall of walls) {
    const halfWidth = wall.widthM / 2;
    const left: V2[] = [];
    const right: V2[] = [];
    for (let i = 0; i < wall.points.length; i++) {
      const point = wall.points[i]!;
      const previous = wall.points[Math.max(0, i - 1)]!;
      const next = wall.points[Math.min(wall.points.length - 1, i + 1)]!;
      const inLength = Math.hypot(point[0] - previous[0], point[1] - previous[1]);
      const outLength = Math.hypot(next[0] - point[0], next[1] - point[1]);
      const incoming: V2 = inLength > 0.001 ? [(point[0] - previous[0]) / inLength, (point[1] - previous[1]) / inLength] : [0, 0];
      const outgoing: V2 = outLength > 0.001 ? [(next[0] - point[0]) / outLength, (next[1] - point[1]) / outLength] : [0, 0];
      const tangent = i === 0 ? outgoing : i === wall.points.length - 1 ? incoming : [incoming[0] + outgoing[0], incoming[1] + outgoing[1]] as const;
      const tangentLength = Math.hypot(tangent[0], tangent[1]);
      const direction: V2 = tangentLength > 0.001 ? [tangent[0] / tangentLength, tangent[1] / tangentLength] : [1, 0];
      const normal: V2 = [-direction[1], direction[0]];
      const isCorner = i > 0 && i < wall.points.length - 1 && inLength > 0.001 && outLength > 0.001;
      let miter: V2 = normal;
      let miterScale = halfWidth;
      if (isCorner) {
        const inNormal: V2 = [-incoming[1], incoming[0]];
        const outNormal: V2 = [-outgoing[1], outgoing[0]];
        const sum: V2 = [inNormal[0] + outNormal[0], inNormal[1] + outNormal[1]];
        const sumLength = Math.hypot(sum[0], sum[1]);
        if (sumLength > 0.001) {
          miter = [sum[0] / sumLength, sum[1] / sumLength];
          const denom = Math.abs(miter[0] * outNormal[0] + miter[1] * outNormal[1]);
          miterScale = Math.min(halfWidth / Math.max(denom, 0.25), halfWidth * 3);
        }
      }
      // Slightly overlap adjoining OSM ways at their shared endpoints to avoid hairline cracks.
      const endExtension = i === 0 ? -halfWidth : i === wall.points.length - 1 ? halfWidth : 0;
      const center: V2 = [point[0] + direction[0] * endExtension, point[1] + direction[1] * endExtension];
      left.push([center[0] + miter[0] * miterScale, center[1] + miter[1] * miterScale]);
      right.push([center[0] - miter[0] * miterScale, center[1] - miter[1] * miterScale]);
    }
    for (let segment = 1; segment < wall.points.length; segment++) {
      const a = wall.points[segment - 1]!;
      const b = wall.points[segment]!;
      const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (length < 0.05) continue;
      const steps = Math.max(1, Math.ceil(length / 2));
      for (let step = 0; step < steps; step++) {
        const interpolate = (from: V2, to: V2, t: number): V2 => [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t];
        const leftStart = interpolate(left[segment - 1]!, left[segment]!, step / steps);
        const leftEnd = interpolate(left[segment - 1]!, left[segment]!, (step + 1) / steps);
        const rightStart = interpolate(right[segment - 1]!, right[segment]!, step / steps);
        const rightEnd = interpolate(right[segment - 1]!, right[segment]!, (step + 1) / steps);
        const corners: V2[] = [leftStart, leftEnd, rightEnd, rightStart];
        const bases = corners.map(([x,z])=>heightAt(x,z)-0.2);
        const tops = bases.map(y=>y+wall.heightM+0.12);
        for (let i=0;i<4;i++) {
          const j=(i+1)%4,p=corners[i]!,q=corners[j]!;
          const sideLength = Math.hypot(q[0]-p[0], q[1]-p[1]);
          pushFacadeQuad(group,p[0],p[1],q[0],q[1],(q[1]-p[1])/sideLength,(p[0]-q[0])/sideLength,0,0,sideLength,bases[i]!,tops[i]!,bases[j]!,tops[j]!);
        }
        const top = (i:number): readonly [number,number,number] => [corners[i]![0],tops[i]!,corners[i]![1]];
        pushRoofTriangle(group,top(0),top(1),top(2),leftStart);
        pushRoofTriangle(group,top(0),top(2),top(3),leftStart);
      }
    }
  }
  return walls.length;
}

/** Triangulo vertical (hastial) con la normal del muro. */
function pushWallTriangle(
  g: GroupBuffers,
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  cx: number,
  cy: number,
  cz: number,
  nx: number,
  nz: number,
): void {
  const length = Math.hypot(nx, nz) || 1;
  const ux = nx / length;
  const uz = nz / length;
  const i0 = pushVertex(g, ax, ay, az, ux, 0, uz);
  const i1 = pushVertex(g, bx, by, bz, ux, 0, uz);
  const i2 = pushVertex(g, cx, cy, cz, ux, 0, uz);
  pushTri(g, i0, i1, i2);
}

/* ------------------------------------------------------------------------- *
 * Mallas y materiales
 * ------------------------------------------------------------------------- */

export function createMaterial(scene: Scene, spec: MaterialSpec, surfaceCache?: FacadeSurfaceCache): PBRMaterial {
  const material = new PBRMaterial(spec.name, scene);
  const albedoScale = 0.65;
  material.albedoColor = new Color3(
    spec.diffuse[0] * albedoScale,
    spec.diffuse[1] * albedoScale,
    spec.diffuse[2] * albedoScale,
  );
  material.metallic = 0;
  material.reflectivityColor = new Color3(0.04, 0.04, 0.04);
  material.roughness = spec.roughness;
  // Mismo criterio que terreno y vias: sin back-face culling, para que un
  // winding invertido no desaparezca una fachada entera.
  material.backFaceCulling = false;
  applyFacadeSurface(material, scene, surfaceCache);
  material.freeze();
  return material;
}

function createMesh(scene: Scene, name: string, group: GroupBuffers, material: PBRMaterial): Mesh | null {
  if (group.indices.length === 0) return null;
  const vertexData = new VertexData();
  vertexData.positions = new Float32Array(group.positions);
  vertexData.normals = new Float32Array(group.normals);
  vertexData.colors = new Float32Array(group.colors);
  // Metre-scaled planar coordinates: maintain grouped meshes and vertex tints.
  // Every wall face owns its vertices, so projection changes cannot smear seams.
  const uvs = new Float32Array(group.positions.length / 3 * 2);
  for (let i = 0; i < group.positions.length; i += 3) {
    const nx = group.normals[i]!;
    const ny = group.normals[i + 1]!;
    const nz = group.normals[i + 2]!;
    const horizontal = Math.abs(ny) > Math.max(Math.abs(nx), Math.abs(nz));
    const length = Math.hypot(nx, nz) || 1;
    if (material.name === 'pueblo:techo-teja' && Math.abs(ny) > 0.25 && Math.hypot(nx, nz) > 0.01) {
      // Across ridge / down slope; correct spacing for the inclined surface.
      uvs[i / 3 * 2] = (group.positions[i]! * nz - group.positions[i + 2]! * nx) / length / FACADE_TILE_METRES;
      uvs[i / 3 * 2 + 1] = (group.positions[i]! * nx + group.positions[i + 2]! * nz) / length / Math.abs(ny) / FACADE_TILE_METRES;
      continue;
    }
    uvs[i / 3 * 2] = (horizontal ? group.positions[i]! :
      (group.positions[i]! * nz - group.positions[i + 2]! * nx) / length) / FACADE_TILE_METRES;
    uvs[i / 3 * 2 + 1] = (horizontal ? group.positions[i + 2]! : group.positions[i + 1]!) / FACADE_TILE_METRES;
  }
  vertexData.uvs = uvs;
  // Uint32 como en las vias: con todos los grupos juntos se pasa de 65.535 vertices.
  vertexData.indices = new Uint32Array(group.indices);
  const mesh = new Mesh(name, scene);
  vertexData.applyToMesh(mesh, false);
  mesh.useVertexColors = true;
  mesh.material = material;
  // Queried by the chase camera's filtered occlusion ray; no pointer selection
  // is used by the game.
  mesh.isPickable = name.startsWith('pueblo:cuerpo:') ||
    name.startsWith('pueblo:tejado:') ||
    name === 'pueblo:detalle';
  mesh.receiveShadows = true;
  mesh.freezeWorldMatrix();
  return mesh;
}

/* ------------------------------------------------------------------------- *
 * Carga
 * ------------------------------------------------------------------------- */

function emptyGroups<T extends string>(keys: readonly T[]): Record<T, GroupBuffers> {
  const out = {} as Record<T, GroupBuffers>;
  for (const key of keys) out[key] = emptyGroup();
  return out;
}

/**
 * Carga el pueblo y construye las mallas. Devuelve las estadisticas del
 * entregable y un `dispose()` que libera mallas y materiales.
 */
export async function loadVillage(
  scene: Scene,
  terrain: WorldTerrain,
  options: LoadVillageOptions = {},
): Promise<Village> {
  const url = options.url ?? DEFAULT_URL;
  const keepClearRadiusM = options.keepClearRadiusM ?? DEFAULT_KEEP_CLEAR_RADIUS_M;
  const keepClearAt = options.keepClearAt ?? null;

  const response = await fetch(url);
  if (!response.ok) throw new Error(`pueblo: no se pudo cargar ${url} (HTTP ${response.status})`);
  let buildings = parseBuildings((await response.json()) as unknown);
  let lidarAdjustedBuildings = 0;
  try {
    const grid = await loadBuildingHeightGrid(options.buildingHeightGridUrl ?? DEFAULT_BUILDING_HEIGHT_GRID_URL);
    buildings = buildings.map((building) => {
      const measuredHeightM = lidarWallHeightM(building, grid, terrain.config);
      if (measuredHeightM === null) return building;
      lidarAdjustedBuildings++;
      return { ...building, heightM: measuredHeightM, heightSource: 'lidar' };
    });
  } catch (error) {
    console.warn('[pueblo] sin alturas LiDAR IGN; se conservan alturas OSM', error);
  }
  const lidarFallbackBuildings = buildings.length - lidarAdjustedBuildings;

  // Dominio real del terreno: `terrain.heightAt` fuera de la ventana devuelve 0
  // (absoluto - datum) y clavaria una casa 870 m bajo tierra. El build ya descarta
  // footprints fuera de ventana; esto es la red de seguridad en runtime.
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const sampler of terrain.samplers) {
    const extent = gridExtent(sampler.grid);
    minX = Math.min(minX, extent.minX);
    maxX = Math.max(maxX, extent.maxX);
    minZ = Math.min(minZ, extent.minZ);
    maxZ = Math.max(maxZ, extent.maxZ);
  }
  const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
  const heightAt = (x: number, z: number): number =>
    terrain.heightAt(clamp(x, minX, maxX), clamp(z, minZ, maxZ));

  // Evita que el terreno tape el alero de casas cuya altura sigue siendo una
  // estimación OSM. Las alturas LiDAR y `height` explícita permanecen intactas.
  let roofLiftedBuildings = 0;
  let maxRoofLiftM = 0;
  let roofLiftCapped = 0;
  buildings = buildings.map((building) => {
    if (building.heightSource === 'lidar' || building.heightSource === 'height') return building;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const [x, z] of building.footprint) {
      const y = heightAt(x, z);
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    const requiredLift = maxY + ROOF_CLEARANCE_M - (minY + building.heightM);
    if (requiredLift <= 1e-6) return building;
    const lift = Math.min(requiredLift, ROOF_MAX_LIFT_M);
    if (requiredLift > ROOF_MAX_LIFT_M) roofLiftCapped++;
    roofLiftedBuildings++;
    maxRoofLiftM = Math.max(maxRoofLiftM, lift);
    return { ...building, heightM: building.heightM + lift };
  });
  if (roofLiftCapped > 0) {
    console.warn(
      `[pueblo] ${roofLiftCapped} cubiertas estimadas superan el tope de elevación (${ROOF_MAX_LIFT_M} m)`,
    );
  }

  const bodies = emptyGroups(BODY_KINDS);
  const roofs = emptyGroups(ROOF_KINDS);
  const details = emptyGroup();
  const plinths = emptyGroup();
  const shutters = emptyGroup();
  const ctx: BuildContext = {
    heightAt,
    roadClearance: options.roadClearance ?? [],
    bodies,
    roofs,
    details,
    plinths,
    shutters,
    detail: keepClearAt
      ? { x: keepClearAt.x, z: keepClearAt.z, radiusM: VILLAGE_DETAIL_RADIUS_M, clearRadiusM: keepClearRadiusM }
      : null,
  };

  // The pilot is one exported, vertex-colored mesh. Keep the procedural path as
  // a resilient fallback so missing/corrupt optional art never removes houses.
  let pilotContainer: AssetContainer | null = null;
  const loadedPilotIds = new Set<number>();
  const pilotWouldBeDropped = keepClearAt !== null && buildings.some(
    (building) => VILLAGE_PILOT_HOUSES[building.id] &&
      distanceToPolygon(building.footprint, keepClearAt.x, keepClearAt.z) < keepClearRadiusM,
  );
  if (!pilotWouldBeDropped) {
    try {
      pilotContainer = await SceneLoader.LoadAssetContainerAsync('', options.pilotAssetUrl ?? '/village/pilot-houses.glb', scene);
      for (const mesh of pilotContainer.meshes) {
        if (!(mesh instanceof Mesh) || mesh.getTotalVertices() === 0) continue;
        // Blender's Y-up and glTF/Babylon root transforms must be baked so the
        // footprint coordinates stay in the same world space as OSM and terrain.
        mesh.computeWorldMatrix(true);
        mesh.bakeTransformIntoVertices(mesh.getWorldMatrix().clone());
        mesh.setParent(null);
        mesh.position.set(0, 0, 0);
        mesh.rotation.set(0, 0, 0);
        mesh.rotationQuaternion = null;
        mesh.scaling.set(1, 1, 1);
        // The exported Blender→glTF frame arrives mirrored on both horizontal
        // axes; a 180° Y rotation restores the positive OSM world coordinates.
        mesh.scaling.set(-1, 1, -1);
        mesh.bakeCurrentTransformIntoVertices();
        mesh.refreshBoundingInfo(true);
        mesh.computeWorldMatrix(true);
        mesh.name = 'pueblo:piloto:casas';
        // The chase camera needs to see the imported village shells as occluders.
        mesh.isPickable = true;
        mesh.checkCollisions = false;
      }
      pilotContainer.addAllToScene();
      for (const id of Object.keys(VILLAGE_PILOT_HOUSES)) loadedPilotIds.add(Number(id));
    } catch (error) {
      pilotContainer?.dispose();
      pilotContainer = null;
      console.warn('[pueblo] GLB del piloto no disponible; se usan las casas procedurales', error);
    }
  }

  let droppedAtSpawn = 0;
  let footprintAreaM2 = 0;
  let tallestM = 0;
  let rendered = 0;
  let detailedBuildings = 0;
  const streetPoles = buildStreetFurniture(ctx);
  for (const building of buildings) {
    if (options.omitBuildingIds?.has(building.id)) continue;
    if (keepClearAt && distanceToPolygon(building.footprint, keepClearAt.x, keepClearAt.z) < keepClearRadiusM) {
      droppedAtSpawn++;
      continue;
    }
    const nearSpawn = ctx.detail !== null && distanceToPolygon(building.footprint, ctx.detail.x, ctx.detail.z) <= ctx.detail.radiusM;
    const frontage = options.facadeRoute ? nearestFacadeRoutePoint(building.footprint, options.facadeRoute.points) : null;
    const nearRoute = frontage !== null && frontage.distanceM <= (options.facadeRoute?.radiusM ?? 0);
    const detailed = nearSpawn || nearRoute;
    if (!loadedPilotIds.has(building.id)) buildBuilding(ctx, building, detailed, nearRoute ? frontage : nearSpawn ? ctx.detail : null);
    if (detailed) detailedBuildings++;
    footprintAreaM2 += Math.abs(signedArea(building.footprint));
    tallestM = Math.max(tallestM, building.heightM);
    rendered++;
  }

  const wallUrl = options.mappedWallsUrl ?? '/village/mapped-walls.json';
  const wallResponse = await fetch(wallUrl);
  if (!wallResponse.ok) throw new Error(`pueblo: mapped wall source unavailable (${wallResponse.status})`);
  const wallData = await wallResponse.json() as { walls: MappedWall[] };
  if (!Array.isArray(wallData.walls) || wallData.walls.some(wall =>
    !Number.isFinite(wall.id) || !(wall.heightM > 0 && wall.heightM < 10) || !(wall.widthM > 0 && wall.widthM < 2) ||
    !Array.isArray(wall.points) || wall.points.length < 2 || wall.points.some(point => point.length !== 2 || !point.every(Number.isFinite)))) {
    throw new Error('pueblo: invalid mapped wall geometry');
  }
  const courtyardWalls = buildMappedWalls(plinths, wallData.walls, heightAt);

  const materials: PBRMaterial[] = [];
  const surfaceCache: FacadeSurfaceCache = new Map();
  const meshes: Mesh[] = [];
  let triangles = 0;
  if (pilotContainer) {
    for (const mesh of pilotContainer.meshes) {
      if (!(mesh instanceof Mesh) || mesh.getTotalVertices() === 0) continue;
      meshes.push(mesh);
      triangles += Math.floor(mesh.getTotalIndices() / 3);
    }
  }
  for (const kind of BODY_KINDS) {
    const material = createMaterial(scene, BODY_MATERIALS[kind], surfaceCache);
    materials.push(material);
    const mesh = createMesh(scene, `pueblo:cuerpo:${kind}`, bodies[kind], material);
    if (mesh) {
      meshes.push(mesh);
      triangles += bodies[kind].triangles;
    }
  }
  for (const kind of ROOF_KINDS) {
    const material = createMaterial(scene, ROOF_MATERIALS[kind], surfaceCache);
    materials.push(material);
    const mesh = createMesh(scene, `pueblo:tejado:${kind}`, roofs[kind], material);
    if (mesh) {
      meshes.push(mesh);
      triangles += roofs[kind].triangles;
    }
  }

  // Lotes de detalle agrupados; no se crea ninguna malla por edificio.
  const extra: readonly { readonly name: string; readonly group: GroupBuffers; readonly spec: MaterialSpec }[] = [
    { name: 'pueblo:zocalo', group: plinths, spec: PLINTH_MATERIAL },
    { name: 'pueblo:detalle', group: details, spec: DETAIL_MATERIAL },
    { name: 'pueblo:contraventanas', group: shutters, spec: SHUTTER_MATERIAL },
  ];
  for (const entry of extra) {
    const material = createMaterial(scene, entry.spec, surfaceCache);
    materials.push(material);
    const mesh = createMesh(scene, entry.name, entry.group, material);
    if (mesh) {
      meshes.push(mesh);
      triangles += entry.group.triangles;
    }
  }

  const stats: VillageStats = {
    buildings: rendered,
    meshes: meshes.length,
    triangles,
    footprintAreaM2: Math.round(footprintAreaM2 * 10) / 10,
    tallestM,
    droppedAtSpawn,
    detailedBuildings,
    courtyardWalls,
    lidarAdjustedBuildings,
    lidarFallbackBuildings,
    roofLiftedBuildings,
    maxRoofLiftM,
    streetPoles,
  };

  console.info(
    `[pueblo] ${stats.buildings} edificios · ${stats.meshes} mallas · ${stats.triangles} triángulos · ` +
      `${stats.footprintAreaM2} m² · más alto ${stats.tallestM} m · ${stats.droppedAtSpawn} descartados en el spawn · ` +
      `${stats.detailedBuildings} con detalle · ${stats.courtyardWalls} tapias · ` +
      `${stats.lidarAdjustedBuildings}/${stats.buildings} alturas LiDAR IGN · ` +
      `${stats.roofLiftedBuildings} cubiertas elevadas (máx ${stats.maxRoofLiftM.toFixed(2)} m) · ` +
      `${stats.streetPoles} postes de calle`,
  );

  return {
    stats,
    dispose: () => {
      pilotContainer?.dispose();
      for (const mesh of meshes) mesh.dispose();
      for (const material of materials) material.dispose();
      for (const textures of surfaceCache.values()) for (const texture of textures) texture.dispose();
      surfaceCache.clear();
    },
  };
}
