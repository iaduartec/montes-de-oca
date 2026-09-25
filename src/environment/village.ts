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
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import type { Scene } from '@babylonjs/core/scene';
import type { WorldTerrain } from '../terrain';
import { gridExtent } from '../heightfield';

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
}

export interface Village {
  readonly stats: VillageStats;
  dispose(): void;
}

export interface LoadVillageOptions {
  /** URL de los datos. Por defecto `/village/buildings.json`. */
  readonly url?: string;
  /** Punto que NO puede quedar tapado por una casa (la aparición del 4x4). */
  readonly keepClearAt?: { readonly x: number; readonly z: number } | null;
  /** Radio a despejar alrededor de `keepClearAt`, en metros. */
  readonly keepClearRadiusM?: number;
  /** Centros de vía locales; cada muestra incluye el semiancho que debe quedar libre. */
  readonly roadClearance?: readonly { readonly x: number; readonly z: number; readonly radiusM: number }[];
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

/** Radio por defecto a despejar alrededor del spawn (contrato: >= 8 m verificado). */
const DEFAULT_KEEP_CLEAR_RADIUS_M = 12;

/**
 * Detalle de fachada: solo edificios a <= esta distancia del spawn. El resto del
 * pueblo mantiene el LOD de presupuesto. Elegido para cubrir el casco visible
 * desde la aparicion y la calle inicial sin inflar los triangulos.
 */
const DETAIL_RADIUS_M = 90;

/* Medidas del detalle (m). Conservadoras: nada que invada calzada ni spawn. */
const PLINTH_HEIGHT_M = 0.55;
const PLINTH_OUT_M = 0.05;
const OPENING_OUT_M = 0.1;
const DOOR_WIDTH_M = 0.95;
const DOOR_HEIGHT_M = 2.0;
const WINDOW_WIDTH_M = 0.7;
const WINDOW_HEIGHT_M = 0.95;
const WINDOW_SILL_M = 1.15;
const SHUTTER_WIDTH_M = 0.14;
const SHUTTER_GAP_M = 0.055;
const SHUTTER_OUT_M = 0.15;
const EAVE_OVERHANG_M = 0.35;
const EAVE_FASCIA_M = 0.16;
const WINDOW_TRIM_OUT_M = OPENING_OUT_M + 0.025;
/** Longitud minima de fachada para colgar un hueco. */
const MIN_FACADE_M = 2.0;

const DEFAULT_URL = '/village/buildings.json';

/** Tipos de material. Cuerpos y tejados se agrupan por separado: 4 + 3 mallas. */
const BODY_KINDS = ['piedra', 'revoco', 'teja', 'ladrillo'] as const;
type BodyKind = (typeof BODY_KINDS)[number];

const ROOF_KINDS = ['teja', 'chapa', 'pizarra'] as const;
type RoofKind = (typeof ROOF_KINDS)[number];

interface MaterialSpec {
  readonly name: string;
  readonly diffuse: readonly [number, number, number];
}

/**
 * Paleta rural plana, sin texturas (presupuesto: 4 colores de muro + 3 de techo).
 * Los colores no son decorativos: son como se distingue una casa de otra a 100 m
 * sin cargar una sola imagen.
 */
const BODY_MATERIALS: Record<BodyKind, MaterialSpec> = {
  piedra: { name: 'pueblo:muro-piedra', diffuse: [0.5, 0.46, 0.4] },
  revoco: { name: 'pueblo:muro-revoco', diffuse: [0.82, 0.76, 0.66] },
  teja: { name: 'pueblo:muro-teja', diffuse: [0.74, 0.6, 0.46] },
  ladrillo: { name: 'pueblo:muro-ladrillo', diffuse: [0.62, 0.38, 0.3] },
};

const ROOF_MATERIALS: Record<RoofKind, MaterialSpec> = {
  teja: { name: 'pueblo:techo-teja', diffuse: [0.6, 0.32, 0.24] },
  chapa: { name: 'pueblo:techo-chapa', diffuse: [0.56, 0.58, 0.59] },
  pizarra: { name: 'pueblo:techo-pizarra', diffuse: [0.32, 0.32, 0.36] },
};

/**
 * Los DOS unicos lotes extra del detalle: huecos (puerta/ventana) y zocalo de
 * piedra. El alero reutiliza el material del tejado, asi que el total pasa de 7 a
 * 9 mallas (7 + 2) y no de mas.
 */
const DETAIL_MATERIAL: MaterialSpec = { name: 'pueblo:detalle', diffuse: [0.15, 0.14, 0.13] };
const PLINTH_MATERIAL: MaterialSpec = { name: 'pueblo:zocalo', diffuse: [0.66, 0.6, 0.5] };
const SHUTTER_MATERIAL: MaterialSpec = { name: 'pueblo:contraventanas', diffuse: [0.34, 0.25, 0.17] };

/* ------------------------------------------------------------------------- *
 * Datos: parseo defensivo de buildings.json
 * ------------------------------------------------------------------------- */

type V2 = readonly [number, number];

interface Building {
  readonly id: number;
  readonly footprint: readonly V2[];
  readonly heightM: number;
  readonly levels: number;
  readonly heightSource: 'levels' | 'height' | 'tipo';
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
  readonly indices: number[];
  triangles: number;
}

function emptyGroup(): GroupBuffers {
  return { positions: [], normals: [], indices: [], triangles: 0 };
}

function pushVertex(g: GroupBuffers, x: number, y: number, z: number, nx: number, ny: number, nz: number): number {
  const index = g.positions.length / 3;
  g.positions.push(x, y, z);
  g.normals.push(nx, ny, nz);
  return index;
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
  /** Muestras del eje viario cercanas al spawn, para orientar ventanas a la calle. */
  readonly roadClearance: readonly { readonly x: number; readonly z: number; readonly radiusM: number }[];
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
function buildBuilding(ctx: BuildContext, building: Building, detailed: boolean): void {
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

  const axis = principalAxis(points);
  const elongation = axis.halfV > 0.5 ? axis.halfU / axis.halfV : 0;
  const gable = elongation >= GABLE_ELONGATION && axis.halfV > 0.5;
  // Puntas del tejado: crecen con el ancho y estan limitadas para que ningun
  // edificio se dispare (una nave de 30 m no lleva un fronton de 8 m).
  const rise = gable ? Math.min(Math.max(0.25 * (2 * axis.halfV), 0.4), 3) : 0;

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
    roofY.push(gable ? topY + rise * (1 - Math.min(1, Math.abs(v) / axis.halfV)) : topY);
  }

  const ccw = signedArea(points) > 0;
  const ridgeSpan = Math.max(1e-6, 2 * axis.halfU);

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

    if (!gable) continue;

    const isEndEdge = Math.abs(projU[i]! - projU[j]!) <= 0.05 * ridgeSpan;
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
  }

  if (!gable) {
    // Tejado plano: tapa el poligono completo en `topY`.
    const indices = triangulatePolygon(points);
    for (let k = 0; k < indices.length; k += 3) {
      const ia = indices[k]!;
      const ib = indices[k + 1]!;
      const ic = indices[k + 2]!;
      pushRoofTriangle(
        roof,
        [points[ia]![0], topY, points[ia]![1]],
        [points[ib]![0], topY, points[ib]![1]],
        [points[ic]![0], topY, points[ic]![1]],
        axis.c,
      );
    }
  }

  if (detailed) {
    buildFacadeDetails(ctx, points, {
      ccw, gable, ridgeSpan, roofY, projU, axis, minY, baseY, roof,
      shutters: building.id % 2 === 0 ? ctx.shutters : null,
    });
    if (gable && n <= 6 && building.id % 2 === 0 && Math.abs(signedArea(points)) >= 35 && axis.halfU >= 2) {
      // La chimenea solo aparece en cubiertas sencillas y cerca del spawn. Se
      // hunde en la cumbrera para que no flote, sin sobresalir del footprint.
      const along = Math.min(axis.halfU * 0.22, 1.3);
      const cx = axis.c[0] + axis.u[0] * along;
      const cz = axis.c[1] + axis.u[1] * along;
      if (distanceToPolygon(points, cx, cz) > 0) return;
      const v: V2 = [-axis.u[1], axis.u[0]];
      const corners: V2[] = [
        [cx - axis.u[0] * 0.28 - v[0] * 0.24, cz - axis.u[1] * 0.28 - v[1] * 0.24],
        [cx + axis.u[0] * 0.28 - v[0] * 0.24, cz + axis.u[1] * 0.28 - v[1] * 0.24],
        [cx + axis.u[0] * 0.28 + v[0] * 0.24, cz + axis.u[1] * 0.28 + v[1] * 0.24],
        [cx - axis.u[0] * 0.28 + v[0] * 0.24, cz - axis.u[1] * 0.28 + v[1] * 0.24],
      ];
      if (corners.some((corner) => distanceToPolygon(points, corner[0], corner[1]) > 0)) return;
      const bottom = topY + rise - 0.35;
      const top = topY + rise + 0.75;
      for (let i = 0; i < 4; i++) {
        const a = corners[i]!;
        const b = corners[(i + 1) % 4]!;
        pushWallStrip(ctx.plinths, a[0], a[1], b[0], b[1], bottom, top, top, b[1] - a[1], a[0] - b[0]);
      }
      pushRoofTriangle(ctx.plinths, [corners[0]![0], top, corners[0]![1]], [corners[1]![0], top, corners[1]![1]], [corners[2]![0], top, corners[2]![1]], axis.c);
      pushRoofTriangle(ctx.plinths, [corners[0]![0], top, corners[0]![1]], [corners[2]![0], top, corners[2]![1]], [corners[3]![0], top, corners[3]![1]], axis.c);
    }
  }
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
}

/**
 * Detalle de fachada de una casa cercana al spawn: zocalo, puerta, ventanas y
 * alero. Determinista (solo geometria), sin invadir el despeje del spawn. Los
 * huecos y el zocalo van a sus lotes; el alero reutiliza el material del techo.
 */
function buildFacadeDetails(ctx: BuildContext, points: readonly V2[], detailCtx: FacadeDetailContext): void {
  const detail = ctx.detail;
  if (!detail) return;
  const { ccw, gable, ridgeSpan, roofY, projU, axis, minY, baseY, roof, shutters } = detailCtx;
  const n = points.length;
  const plinthTop = minY + PLINTH_HEIGHT_M;

  // 1. Zocalo de piedra: una banda por arista, de la base enterrada a `plinthTop`.
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const facade = facadeOf(points[i]!, points[j]!, ccw, i, j);
    if (!facade) continue;
    pushFacadeQuad(
      ctx.plinths,
      facade.ax,
      facade.az,
      facade.bx,
      facade.bz,
      facade.ux,
      facade.uz,
      PLINTH_OUT_M,
      0,
      facade.len,
      baseY,
      plinthTop,
    );
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
    Math.hypot(x - detail.x, z - detail.z) >= detail.clearRadiusM;
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
    const vx = detail.x - mx;
    const vz = detail.z - mz;
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
  let doorInterval: readonly [number, number] | null = null;
  const main = facades.find((facade) => facingSpawn(facade) > 0.3) ?? facades[0];
  if (main) {
    const s = main.len / 2;
    const ground = pointOn(main, s, 0);
    const out = pointOn(main, s, OPENING_OUT_M);
    // La puerta tapa el zocalo desde el suelo local, con un umbral minimo.
    const y0 = ctx.heightAt(ground.x, ground.z) + 0.03;
    const y1 = y0 + DOOR_HEIGHT_M;
    if (y1 <= topAt(main, s) - 0.1 && clear(out.x, out.z)) {
      const s0 = s - DOOR_WIDTH_M / 2;
      const s1 = s + DOOR_WIDTH_M / 2;
      pushFacadeQuad(ctx.details, main.ax, main.az, main.bx, main.bz, main.ux, main.uz, OPENING_OUT_M, s0, s1, y0, y1);
      pushFacadeQuad(ctx.plinths, main.ax, main.az, main.bx, main.bz, main.ux, main.uz, WINDOW_TRIM_OUT_M, s0 - 0.1, s0 - 0.025, y0, y1 + 0.05);
      pushFacadeQuad(ctx.plinths, main.ax, main.az, main.bx, main.bz, main.ux, main.uz, WINDOW_TRIM_OUT_M, s1 + 0.025, s1 + 0.1, y0, y1 + 0.05);
      pushFacadeQuad(ctx.plinths, main.ax, main.az, main.bx, main.bz, main.ux, main.uz, WINDOW_TRIM_OUT_M, s0 - 0.1, s1 + 0.1, y0 - 0.05, y0 + 0.02);
      if (y1 + 0.14 < topAt(main, s)) {
        pushFacadeQuad(ctx.plinths, main.ax, main.az, main.bx, main.bz, main.ux, main.uz, WINDOW_TRIM_OUT_M, s0 - 0.12, s1 + 0.12, y1 + 0.04, y1 + 0.14);
      }
      doorInterval = [s0, s1];
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

  // La puerta sigue orientada al spawn. Las ventanas priorizan además las
  // fachadas expuestas a la calle, sin decorar paredes ciegas entre edificios.
  const ordered = facades
    .filter((facade) => facade !== main)
    .sort((left, right) => roadFacing(right) - roadFacing(left) || right.len - left.len);
  const windowFacades = main ? [main, ...ordered.slice(0, 2)] : ordered.slice(0, 3);
  for (const facade of windowFacades) {
    for (let floor = 0; floor < 3; floor++) {
      if (facade.len >= 3.2) {
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
    const oax = facade.ax + facade.ux * EAVE_OVERHANG_M;
    const oaz = facade.az + facade.uz * EAVE_OVERHANG_M;
    const obx = facade.bx + facade.ux * EAVE_OVERHANG_M;
    const obz = facade.bz + facade.uz * EAVE_OVERHANG_M;
    pushRoofTriangle(roof, [facade.ax, topA, facade.az], [facade.bx, topB, facade.bz], [obx, topB, obz], axis.c);
    pushRoofTriangle(roof, [facade.ax, topA, facade.az], [obx, topB, obz], [oax, topA, oaz], axis.c);
    pushFacadeQuad(
      roof, oax, oaz, obx, obz, facade.ux, facade.uz, 0, 0, facade.len,
      topA - EAVE_FASCIA_M, topA, topB - EAVE_FASCIA_M, topB,
    );
  }
}

interface YardWallCandidate {
  readonly building: Building;
  readonly facade: Facade;
  readonly centerS: number;
  readonly offsetM: number;
  readonly lengthM: number;
  readonly score: number;
  readonly center: V2;
}

/** Una tapia baja en patios con espacio libre; comparte el lote de piedra. */
function buildYardWalls(
  group: GroupBuffers,
  buildings: readonly Building[],
  keepClearAt: { readonly x: number; readonly z: number } | null,
  clearRadiusM: number,
  heightAt: (x: number, z: number) => number,
  roadClearance: readonly { readonly x: number; readonly z: number; readonly radiusM: number }[],
): number {
  if (!keepClearAt) return 0;
  const candidates: YardWallCandidate[] = [];
  for (const building of buildings) {
    if (distanceToPolygon(building.footprint, keepClearAt.x, keepClearAt.z) > DETAIL_RADIUS_M) continue;
    const ccw = signedArea(building.footprint) > 0;
    const facades = building.footprint.flatMap((a, i) => {
      const j = (i + 1) % building.footprint.length;
      const facade = facadeOf(a, building.footprint[j]!, ccw, i, j);
      return facade && facade.len >= 5 ? [facade] : [];
    });
    for (const facade of facades) {
      const mx = (facade.ax + facade.bx) / 2;
      const mz = (facade.az + facade.bz) / 2;
      const toSpawnX = keepClearAt.x - mx;
      const toSpawnZ = keepClearAt.z - mz;
      const spawnDistance = Math.hypot(toSpawnX, toSpawnZ) || 1;
      const facing = (facade.ux * toSpawnX + facade.uz * toSpawnZ) / spawnDistance;
      if (facing < -0.15) continue;

      const lengthM = Math.min(4.2, facade.len * 0.62);
      const side = (building.id & 1) === 0 ? 0.31 : 0.69;
      const centerS = facade.len * side;
      const offsetM = 2.15;
      const centerX = facade.ax + ((facade.bx - facade.ax) / facade.len) * centerS + facade.ux * offsetM;
      const centerZ = facade.az + ((facade.bz - facade.az) / facade.len) * centerS + facade.uz * offsetM;
      const score = facing * 3 - spawnDistance / 80 + ((building.id >>> 3) % 17) * 0.001;
      candidates.push({ building, facade, centerS, offsetM, lengthM, score, center: [centerX, centerZ] });
    }
  }

  candidates.sort((a, b) => b.score - a.score || a.building.id - b.building.id);
  const acceptedCenters: V2[] = [];
  const acceptedBuildings = new Set<number>();
  let built = 0;
  for (const candidate of candidates) {
    if (built >= 12) break;
    if (acceptedBuildings.has(candidate.building.id)) continue;
    if (acceptedCenters.some((center) => Math.hypot(center[0] - candidate.center[0], center[1] - candidate.center[1]) < 8)) continue;
    const { building, facade, centerS, offsetM, lengthM } = candidate;
    const startS = centerS - lengthM / 2;
    const endS = centerS + lengthM / 2;
    const ex = (facade.bx - facade.ax) / facade.len;
    const ez = (facade.bz - facade.az) / facade.len;
    const pointAt = (s: number): V2 => [facade.ax + ex * s + facade.ux * offsetM, facade.az + ez * s + facade.uz * offsetM];
    const samples = Array.from({ length: 7 }, (_, i) => pointAt(startS + (endS - startS) * (i / 6)));
    let clear = true;
    for (const [x, z] of samples) {
      if (Math.hypot(x - keepClearAt.x, z - keepClearAt.z) < clearRadiusM + 2) {
        clear = false;
        break;
      }
      if (roadClearance.some((road) => Math.hypot(x - road.x, z - road.z) < road.radiusM + 0.35)) {
        clear = false;
        break;
      }
      if (buildings.some((other) => other.id !== building.id && distanceToPolygon(other.footprint, x, z) < 0.4)) {
        clear = false;
        break;
      }
    }
    if (!clear) continue;

    const a = pointAt(startS);
    const b = pointAt(endS);
    const tangentX = (b[0] - a[0]) / lengthM;
    const tangentZ = (b[1] - a[1]) / lengthM;
    const normalX = -tangentZ * 0.12;
    const normalZ = tangentX * 0.12;
    const corners: V2[] = [
      [a[0] - normalX, a[1] - normalZ],
      [b[0] - normalX, b[1] - normalZ],
      [b[0] + normalX, b[1] + normalZ],
      [a[0] + normalX, a[1] + normalZ],
    ];
    const bases = corners.map(([x, z]) => heightAt(x, z) - 0.06);
    const tops = bases.map((base) => base + 0.95);
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      const p = corners[i]!;
      const q = corners[j]!;
      pushWallStrip(group, p[0], p[1], q[0], q[1], bases[i]!, tops[i]!, tops[j]!, q[1] - p[1], p[0] - q[0]);
    }
    pushRoofTriangle(group,
      [corners[0]![0], tops[0]!, corners[0]![1]],
      [corners[1]![0], tops[1]!, corners[1]![1]],
      [corners[2]![0], tops[2]!, corners[2]![1]], candidate.center);
    pushRoofTriangle(group,
      [corners[0]![0], tops[0]!, corners[0]![1]],
      [corners[2]![0], tops[2]!, corners[2]![1]],
      [corners[3]![0], tops[3]!, corners[3]![1]], candidate.center);
    acceptedCenters.push(candidate.center);
    acceptedBuildings.add(building.id);
    built++;
  }
  return built;
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

function createMaterial(scene: Scene, spec: MaterialSpec): StandardMaterial {
  const material = new StandardMaterial(spec.name, scene);
  material.diffuseColor = new Color3(spec.diffuse[0], spec.diffuse[1], spec.diffuse[2]);
  material.specularColor = new Color3(0.04, 0.04, 0.04);
  material.ambientColor = new Color3(0.25, 0.25, 0.25);
  // Mismo criterio que terreno y vias: sin back-face culling, para que un
  // winding invertido no desaparezca una fachada entera.
  material.backFaceCulling = false;
  material.freeze();
  return material;
}

function createMesh(scene: Scene, name: string, group: GroupBuffers, material: StandardMaterial): Mesh | null {
  if (group.indices.length === 0) return null;
  const vertexData = new VertexData();
  vertexData.positions = new Float32Array(group.positions);
  vertexData.normals = new Float32Array(group.normals);
  // Uint32 como en las vias: con todos los grupos juntos se pasa de 65.535 vertices.
  vertexData.indices = new Uint32Array(group.indices);
  const mesh = new Mesh(name, scene);
  vertexData.applyToMesh(mesh, false);
  mesh.material = material;
  mesh.isPickable = false;
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
  const buildings = parseBuildings((await response.json()) as unknown);

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
      ? { x: keepClearAt.x, z: keepClearAt.z, radiusM: DETAIL_RADIUS_M, clearRadiusM: keepClearRadiusM }
      : null,
  };

  let droppedAtSpawn = 0;
  let footprintAreaM2 = 0;
  let tallestM = 0;
  let rendered = 0;
  let detailedBuildings = 0;
  for (const building of buildings) {
    if (keepClearAt && distanceToPolygon(building.footprint, keepClearAt.x, keepClearAt.z) < keepClearRadiusM) {
      droppedAtSpawn++;
      continue;
    }
    const detailed =
      ctx.detail !== null && distanceToPolygon(building.footprint, ctx.detail.x, ctx.detail.z) <= ctx.detail.radiusM;
    buildBuilding(ctx, building, detailed);
    if (detailed) detailedBuildings++;
    footprintAreaM2 += Math.abs(signedArea(building.footprint));
    tallestM = Math.max(tallestM, building.heightM);
    rendered++;
  }

  const courtyardWalls = buildYardWalls(
    plinths,
    buildings,
    keepClearAt,
    keepClearRadiusM,
    heightAt,
    options.roadClearance ?? [],
  );

  const materials: StandardMaterial[] = [];
  const meshes: Mesh[] = [];
  let triangles = 0;
  for (const kind of BODY_KINDS) {
    const material = createMaterial(scene, BODY_MATERIALS[kind]);
    materials.push(material);
    const mesh = createMesh(scene, `pueblo:cuerpo:${kind}`, bodies[kind], material);
    if (mesh) {
      meshes.push(mesh);
      triangles += bodies[kind].triangles;
    }
  }
  for (const kind of ROOF_KINDS) {
    const material = createMaterial(scene, ROOF_MATERIALS[kind]);
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
    const material = createMaterial(scene, entry.spec);
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
  };

  console.info(
    `[pueblo] ${stats.buildings} edificios · ${stats.meshes} mallas · ${stats.triangles} triángulos · ` +
      `${stats.footprintAreaM2} m² · más alto ${stats.tallestM} m · ${stats.droppedAtSpawn} descartados en el spawn · ` +
      `${stats.detailedBuildings} con detalle · ${stats.courtyardWalls} tapias de patio`,
  );

  return {
    stats,
    dispose: () => {
      for (const mesh of meshes) mesh.dispose();
      for (const material of materials) material.dispose();
    },
  };
}
