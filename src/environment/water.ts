/**
 * TAREA 4 — Agua runtime: láminas, cintas, presa y consultas del 4x4.
 *
 * `public/water/water.json` trae la geometría en metros ABSOLUTOS (cota sobre el
 * nivel del mar); este módulo es el único que la pasa a Y de mundo restando el
 * datum (`terrain.config.verticalDatum * worldScale`), igual que `terrain.ts`.
 * La altura del terreno se pregunta SIEMPRE con `terrain.heightAt`
 * (interpolación triangular SO->NE, la superficie exacta del motor): una
 * bilineal propia desvía hasta 0,29 m y rompería la invariante de las cintas.
 *
 * Tres decisiones que cierra este archivo (detalles en docs/environment/AGUA.md):
 *
 *  1. TRES MALLAS, una por material (`agua:laminas`, `agua:cintas`,
 *     `agua:presa`). `StandardMaterial` plano, sin transparencia ni reflejos ni
 *     animación; la profundidad se lee por tono de vértice, no por alfa.
 *  2. LAS CINTAS SE CONSTRUYEN CON LOS `points` TAL CUAL (lerp lineal +
 *     `caladoM`), sin subdivisión: los datos ya vienen densificados (paso
 *     2,5 m + vértices extra en los cruces de triángulo) con la invariante
 *     "superficie >= terreno + 0,02 m en todo el eje" verificada. Subdividir
 *     con otra interpolación la rompería; por eso cada estación da dos
 *     vértices (izquierda/derecha) y cada tramo dos triángulos.
 *  3. BARRO LIMITADO (ruling del controlador, ver `isMuddy`): la banda de
 *     orilla de <=12 m con pendiente <20° vale SOLO para las láminas; en las
 *     cintas la orilla húmeda es ~2 m. 60 cintas x 12 m pintarían el valle de
 *     barro e incluirían el camino vecino a los arroyos. La consulta es O(1)
 *     por una grilla booleana precalculada en la carga.
 */

import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData';
import type { Scene } from '@babylonjs/core/scene';
import { gridExtent } from '../heightfield';
import type { WorldTerrain } from '../terrain';

/* ------------------------------------------------------------------------- *
 * Contrato (lo consumen main.ts y las reglas del 4x4 de T5)
 * ------------------------------------------------------------------------- */

export interface WaterStats {
  readonly sheets: number;
  readonly ribbons: number;
  readonly meshes: number;
  readonly triangles: number;
  readonly dataBytes: number;
}

export interface Water {
  readonly stats: WaterStats;
  /** 0 en seco; `caladoM` en cintas; batimetría en el vaso; nivel−terreno en láminas menores. */
  depthAt(x: number, z: number): number;
  /** Banda húmeda: profundidad 0,05–0,5 m, u orilla (12 m láminas / 2 m cintas) con pendiente <20°. */
  isMuddy(x: number, z: number): boolean;
  /** Primer punto seco con pendiente <20° en anillos de 25 m hasta 150 m; `null` si no hay. */
  nearestSafeShore(x: number, z: number): { x: number; z: number } | null;
  dispose(): void;
}

export interface LoadWaterOptions {
  /** URL de los datos. Por defecto `/water/water.json`. */
  readonly url?: string;
  /** Omite únicamente el muro genérico si ya se cargó una presa detallada. */
  readonly includeDam?: boolean;
}

/* ------------------------------------------------------------------------- *
 * Datos: parseo defensivo de water.json
 * ------------------------------------------------------------------------- */

const DEFAULT_URL = '/water/water.json';

type XZ = readonly [number, number];

interface SheetData {
  readonly id: string;
  readonly kind: string;
  readonly levelM: number;
  /** Ancho de la banda de espuma del borde, en metros (el dato trae 1,5). */
  readonly foamM: number;
  readonly ring: readonly (readonly [number, number])[];
  readonly indices: readonly number[];
}

interface RibbonData {
  readonly kind: string;
  readonly widthM: number;
  readonly caladoM: number;
  /** Eje densificado: [x, z, cotaAbsolutaDelTerreno] (superficie triangular exacta). */
  readonly points: readonly (readonly [number, number, number])[];
}

interface DamData {
  readonly a: XZ;
  readonly b: XZ;
  readonly crestM: number;
  readonly baseM: number;
  readonly widthM: number;
}

interface DepthGridData {
  readonly originX: number;
  readonly originZ: number;
  readonly cellM: number;
  readonly cols: number;
  readonly rows: number;
  readonly depthsDm: readonly number[];
  /** Profundidad máxima real (m); normaliza el degradado del vaso. */
  readonly maxDepthM: number;
}

interface WaterData {
  readonly sheets: readonly SheetData[];
  readonly ribbons: readonly RibbonData[];
  readonly dam: DamData | null;
  readonly grid: DepthGridData | null;
  readonly bytes: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function parsePair(value: unknown): XZ | null {
  if (!Array.isArray(value) || value.length < 2) return null;
  if (!isFiniteNumber(value[0]) || !isFiniteNumber(value[1])) return null;
  return [value[0], value[1]];
}

function parseSheets(raw: unknown): SheetData[] {
  if (!Array.isArray(raw)) throw new Error('agua: falta el array "sheets"');
  const out: SheetData[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    if (!isFiniteNumber(item.levelM)) continue;
    if (!Array.isArray(item.ring) || item.ring.length < 3) continue;
    if (!Array.isArray(item.indices) || item.indices.length < 3 || item.indices.length % 3 !== 0) continue;
    const ring: [number, number][] = [];
    let ringOk = true;
    for (const point of item.ring) {
      const pair = parsePair(point);
      if (!pair) {
        ringOk = false;
        break;
      }
      ring.push([pair[0], pair[1]]);
    }
    if (!ringOk) continue;
    const indices: number[] = [];
    let indicesOk = true;
    for (const index of item.indices) {
      if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= ring.length) {
        indicesOk = false;
        break;
      }
      indices.push(index);
    }
    if (!indicesOk) continue;
    out.push({
      id: typeof item.id === 'string' ? item.id : 'lamina',
      kind: typeof item.kind === 'string' ? item.kind : 'pond',
      levelM: item.levelM,
      foamM: isFiniteNumber(item.foamM) && item.foamM > 0 ? item.foamM : 1.5,
      ring,
      indices,
    });
  }
  return out;
}

function parseRibbons(raw: unknown): RibbonData[] {
  if (!Array.isArray(raw)) throw new Error('agua: falta el array "ribbons"');
  const out: RibbonData[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    if (!isFiniteNumber(item.widthM) || item.widthM <= 0) continue;
    if (!isFiniteNumber(item.caladoM) || item.caladoM <= 0) continue;
    if (!Array.isArray(item.points) || item.points.length < 2) continue;
    const points: [number, number, number][] = [];
    let ok = true;
    for (const point of item.points) {
      if (!Array.isArray(point) || point.length < 3) {
        ok = false;
        break;
      }
      if (!isFiniteNumber(point[0]) || !isFiniteNumber(point[1]) || !isFiniteNumber(point[2])) {
        ok = false;
        break;
      }
      points.push([point[0], point[1], point[2]]);
    }
    if (!ok) continue;
    out.push({
      kind: typeof item.kind === 'string' ? item.kind : 'stream',
      widthM: item.widthM,
      caladoM: item.caladoM,
      points,
    });
  }
  return out;
}

function parseDam(raw: unknown): DamData | null {
  if (raw === null || raw === undefined) return null;
  if (!isRecord(raw)) throw new Error('agua: "dam" no es un objeto');
  const a = parsePair(raw.a);
  const b = parsePair(raw.b);
  if (!a || !b) throw new Error('agua: "dam" sin extremos a/b válidos');
  if (!isFiniteNumber(raw.crestM) || !isFiniteNumber(raw.baseM) || !isFiniteNumber(raw.widthM)) {
    throw new Error('agua: "dam" sin cotas/ancho válidos');
  }
  return { a, b, crestM: raw.crestM, baseM: raw.baseM, widthM: Math.max(1, raw.widthM) };
}

function parseGrid(raw: unknown): DepthGridData | null {
  if (raw === null || raw === undefined) return null;
  if (!isRecord(raw)) throw new Error('agua: "depthGrid" no es un objeto');
  const { originX, originZ, cellM, cols, rows, depthsDm } = raw;
  if (!isFiniteNumber(originX) || !isFiniteNumber(originZ) || !isFiniteNumber(cellM) || cellM <= 0) {
    throw new Error('agua: "depthGrid" sin origen/celda válidos');
  }
  if (typeof cols !== 'number' || !Number.isInteger(cols) || cols <= 0) throw new Error('agua: "depthGrid" sin cols');
  if (typeof rows !== 'number' || !Number.isInteger(rows) || rows <= 0) throw new Error('agua: "depthGrid" sin rows');
  if (!Array.isArray(depthsDm) || depthsDm.length !== cols * rows) throw new Error('agua: "depthGrid" con depthsDm incompleto');
  const depths: number[] = [];
  for (const depth of depthsDm) {
    if (!isFiniteNumber(depth) || depth < 0) throw new Error('agua: "depthGrid" con profundidad inválida');
    depths.push(depth);
  }
  // `maxDepthM` lo trae el dato (8,3 m reales junto a la presa, no los 18 m
  // estimados); si falta se deriva del propio campo, nunca se inventa.
  const maxDepthM = isFiniteNumber(raw.maxDepthM) && raw.maxDepthM > 0
    ? raw.maxDepthM
    : Math.max(1, ...depths) / 10;
  return { originX, originZ, cellM, cols, rows, depthsDm: depths, maxDepthM };
}

function parseWaterData(raw: unknown, bytes: number): WaterData {
  if (!isRecord(raw)) throw new Error('agua: la raíz debe ser un objeto');
  const meta = raw.meta;
  const versionOk = raw.schemaVersion === 1 || (isRecord(meta) && meta.schemaVersion === 1);
  if (!versionOk) throw new Error('agua: schemaVersion no soportada');
  return {
    sheets: parseSheets(raw.sheets),
    ribbons: parseRibbons(raw.ribbons),
    dam: parseDam(raw.dam ?? null),
    grid: parseGrid(raw.depthGrid ?? null),
    bytes,
  };
}

/* ------------------------------------------------------------------------- *
 * Color: claro en la orilla, azul oscuro en el vaso (del brief de T4)
 * ------------------------------------------------------------------------- */

/** Color por vértice: claro en la orilla, azul oscuro en el vaso; el terreno no se toca. */
function sheetColor(depthM: number, foam: boolean, deepM = 18): [number, number, number] {
  if (foam) return [0.86, 0.9, 0.92];
  const t = Math.max(0, Math.min(1, depthM / Math.max(1, deepM)));
  return [0.32 - 0.18 * t, 0.52 - 0.24 * t, 0.66 - 0.24 * t];
}

/**
 * Cintas: tono claro de agua con espuma en los vértices laterales. Como la tira
 * se construye con dos vértices por estación (izquierda/derecha, sin vértice
 * central: duplicarlos doblaría los ~31,7 k triángulos y rompería el
 * presupuesto), TODOS los vértices son laterales y llevan el tono mezclado.
 * El valor es deliberadamente más oscuro que el render final: con normal hacia
 * arriba el sol lo levanta ~un 30 % y debe seguir leyéndose azul claro.
 */
const RIBBON_COLOR: [number, number, number] = [0.47, 0.6, 0.71];

/** Hormigón del muro, plano como el resto de la capa. */
const DAM_COLOR: [number, number, number] = [0.6, 0.6, 0.62];

/* ------------------------------------------------------------------------- *
 * Geometría 2D compartida
 * ------------------------------------------------------------------------- */

/** True si (x,z) cae dentro del anillo (ray casting; borde = dentro). */
function containsPoint(ring: readonly (readonly [number, number])[], x: number, z: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!;
    const b = ring[j]!;
    if (a[1] > z !== b[1] > z && x < ((b[0] - a[0]) * (z - a[1])) / (b[1] - a[1]) + a[0]) {
      inside = !inside;
    }
  }
  return inside;
}

function pointSegDist(
  px: number,
  pz: number,
  ax: number,
  az: number,
  bx: number,
  bz: number,
): number {
  const dx = bx - ax;
  const dz = bz - az;
  const len2 = dx * dx + dz * dz;
  let t = len2 > 0 ? ((px - ax) * dx + (pz - az) * dz) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const ex = ax + t * dx - px;
  const ez = az + t * dz - pz;
  return Math.sqrt(ex * ex + ez * ez);
}

interface BBox {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

function emptyBBox(): BBox {
  return { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
}

function growBBox(box: BBox, x: number, z: number): void {
  if (x < box.minX) box.minX = x;
  if (x > box.maxX) box.maxX = x;
  if (z < box.minZ) box.minZ = z;
  if (z > box.maxZ) box.maxZ = z;
}

/**
 * Índice uniforme de segmentos para consultas puntuales. Cada segmento se
 * registra en las celdas que cubre su bbox inflado; el punto solo mira su
 * propia celda. Sin esto, `depthAt` recorrería ~16 k segmentos por consulta.
 */
class SegmentGrid {
  private readonly cellM: number;
  private readonly inflateM: number;
  private readonly cells = new Map<number, number[]>();
  readonly segments: { ax: number; az: number; bx: number; bz: number; halfM: number; caladoM: number }[] = [];

  constructor(cellM: number, inflateM: number) {
    this.cellM = cellM;
    this.inflateM = inflateM;
  }

  add(ax: number, az: number, bx: number, bz: number, halfM: number, caladoM: number): number {
    const index = this.segments.length;
    this.segments.push({ ax, az, bx, bz, halfM, caladoM });
    const inflate = this.inflateM + halfM;
    const i0 = Math.floor((Math.min(ax, bx) - inflate) / this.cellM);
    const i1 = Math.floor((Math.max(ax, bx) + inflate) / this.cellM);
    const j0 = Math.floor((Math.min(az, bz) - inflate) / this.cellM);
    const j1 = Math.floor((Math.max(az, bz) + inflate) / this.cellM);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const key = i * 8192 + j;
        const list = this.cells.get(key);
        if (list) list.push(index);
        else this.cells.set(key, [index]);
      }
    }
    return index;
  }

  candidates(x: number, z: number): readonly number[] {
    const key = Math.floor(x / this.cellM) * 8192 + Math.floor(z / this.cellM);
    return this.cells.get(key) ?? [];
  }
}

/* ------------------------------------------------------------------------- *
 * Buffers por malla
 * ------------------------------------------------------------------------- */

interface MeshBuffers {
  readonly positions: number[];
  readonly normals: number[];
  readonly colors: number[];
  readonly indices: number[];
  triangles: number;
}

function emptyBuffers(): MeshBuffers {
  return { positions: [], normals: [], colors: [], indices: [], triangles: 0 };
}

function pushVertex(
  g: MeshBuffers,
  x: number,
  y: number,
  z: number,
  nx: number,
  ny: number,
  nz: number,
  color: readonly [number, number, number],
): number {
  const index = g.positions.length / 3;
  g.positions.push(x, y, z);
  g.normals.push(nx, ny, nz);
  g.colors.push(color[0], color[1], color[2], 1);
  return index;
}

function pushTri(g: MeshBuffers, a: number, b: number, c: number): void {
  g.indices.push(a, b, c);
  g.triangles++;
}

function createWaterMesh(scene: Scene, name: string, buffers: MeshBuffers, emissive?: readonly [number, number, number]): Mesh {
  const vertexData = new VertexData();
  vertexData.positions = buffers.positions;
  vertexData.normals = buffers.normals;
  vertexData.colors = buffers.colors;
  vertexData.indices = buffers.indices;
  const mesh = new Mesh(name, scene);
  vertexData.applyToMesh(mesh, false);
  const material = new StandardMaterial(name, scene);
  // Blanco a propósito: el color real lo pone el vértice (`useVertexColors`),
  // igual que vegetación y vías. Sin reflejos ni alfa: la profundidad se lee
  // por tono, no por transparencia (AGUA.md §4).
  material.diffuseColor = new Color3(1, 1, 1);
  material.specularColor = new Color3(0, 0, 0);
  material.ambientColor = new Color3(0.35, 0.35, 0.35);
  if (emissive) material.emissiveColor = new Color3(emissive[0], emissive[1], emissive[2]);
  material.backFaceCulling = false;
  material.freeze();
  mesh.material = material;
  mesh.useVertexColors = true;
  // Plano como las vías: recibir sombras sobre una superficie casi coplanar al
  // terreno deja aliasing verde del shadow map (mismo motivo que road-draping).
  mesh.receiveShadows = false;
  mesh.isPickable = false;
  mesh.freezeWorldMatrix();
  return mesh;
}

/* ------------------------------------------------------------------------- *
 * Carga
 * ------------------------------------------------------------------------- */

/** Pendiente <20° en la práctica: tan(20°) ≈ 0,364. */
const MAX_SLOPE_TAN = 0.364;
/** Paso de las diferencias finitas: el paso del DEM (AGUA.md §5.1). */
const SLOPE_STEP_M = 5;
/** Banda de orilla húmeda junto a láminas (ruling: NO vale para cintas). */
const SHEET_SHORE_M = 12;
/** Banda de orilla húmeda junto a cintas (ruling del controlador). */
const RIBBON_SHORE_M = 2;
/** Celda de la grilla booleana de barro (O(1) en consulta). */
const MUD_CELL_M = 4;
/** Margen de la grilla de barro más allá del agua (cubre la banda de 12 m). */
const MUD_MARGIN_M = 16;

export async function loadWater(
  scene: Scene,
  terrain: WorldTerrain,
  options: LoadWaterOptions = {},
): Promise<Water> {
  const url = options.url ?? DEFAULT_URL;
  let response: Response;
  try {
    response = await fetch(url);
  } catch (error) {
    // Esta capa es decorativa y un fallo de transporte puntual no debe dejar el
    // valle sin agua. Se hace un único reintento sin caché; el fallo original se
    // registra y, si persiste, ambos errores llegan al manejador del bootstrap.
    console.warn('[agua] primer intento de red fallido; reintento único sin caché.', error);
    try {
      response = await fetch(url, { cache: 'reload' });
    } catch (retryError) {
      throw new AggregateError([error, retryError], `agua: fallaron ambos intentos para ${url}`, { cause: retryError });
    }
  }
  if (!response.ok) throw new Error(`agua: no se pudo cargar ${url} (HTTP ${response.status})`);
  const text = await response.text();
  const data = parseWaterData(JSON.parse(text) as unknown, new TextEncoder().encode(text).length);

  // Absoluto -> mundo: la MISMA resta que terrain.ts (datum * escala).
  const datum = terrain.config.verticalDatum * terrain.config.worldScale;
  const toWorld = (absM: number): number => absM - datum;
  const heightAt = (x: number, z: number): number => terrain.heightAt(x, z);

  /* ----- Profundidad por lámina ----- */

  const gridDepthAt = (x: number, z: number): number | null => {
    const grid = data.grid;
    if (!grid) return null;
    const fx = (x - grid.originX) / grid.cellM;
    const fz = (z - grid.originZ) / grid.cellM;
    if (fx < 0 || fz < 0 || fx > grid.cols - 1 || fz > grid.rows - 1) return null;
    // Bilineal de las 4 celdas vecinas, con clamp en los bordes (AGUA.md §5.1).
    const x0 = Math.min(grid.cols - 2, Math.max(0, Math.floor(fx)));
    const z0 = Math.min(grid.rows - 2, Math.max(0, Math.floor(fz)));
    const tx = Math.min(1, Math.max(0, fx - x0));
    const tz = Math.min(1, Math.max(0, fz - z0));
    const at = (col: number, row: number): number => grid.depthsDm[row * grid.cols + col]! / 10;
    const top = at(x0, z0) + (at(x0 + 1, z0) - at(x0, z0)) * tx;
    const bottom = at(x0, z0 + 1) + (at(x0 + 1, z0 + 1) - at(x0, z0 + 1)) * tx;
    return top + (bottom - top) * tz;
  };

  /** Profundidad sobre un punto de lámina: batimetría en el embalse, nivel−terreno en las menores. */
  const sheetDepthAt = (sheet: SheetData, x: number, z: number): number => {
    if (sheet.kind === 'reservoir') {
      const gridDepth = gridDepthAt(x, z);
      if (gridDepth !== null) return Math.max(0, gridDepth);
    }
    // Sin batimetría: profundidad real sobre el terreno, con tope (AGUA.md §5.1).
    return Math.max(0, Math.min(1.5, sheet.levelM - (heightAt(x, z) + datum)));
  };

  /* ----- Malla 1: láminas ----- */

  const sheetsBuffers = emptyBuffers();
  const sheetBoxes: BBox[] = [];
  // El degradado del vaso se normaliza con la batimetría REAL (8,3 m junto a
  // la presa); con los 18 m estimados el interior nunca pasaba del azul medio.
  const deepM = data.grid?.maxDepthM ?? 18;
  for (const sheet of data.sheets) {
    const box = emptyBBox();
    const levelY = toWorld(sheet.levelM);
    const base = sheetsBuffers.positions.length / 3;
    // Espuma por DISTANCIA al borde (AGUA.md §4: banda de 1-2 m; el dato trae
    // `foamM`), no por umbral de profundidad: con el umbral (0,4 m) las
    // plataformas someras del vaso se pintaban de blanco y la lámina se leía
    // como hielo (captura water_vaso.png del gate de T4).
    const edgeDist = (x: number, z: number): number => {
      let best = Infinity;
      const ring = sheet.ring;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const d = pointSegDist(x, z, ring[j]![0], ring[j]![1], ring[i]![0], ring[i]![1]);
        if (d < best) best = d;
      }
      return best;
    };
    const foamAt = (x: number, z: number): boolean => edgeDist(x, z) <= sheet.foamM;
    for (const [x, z] of sheet.ring) {
      growBBox(box, x, z);
      const depth = sheetDepthAt(sheet, x, z);
      pushVertex(sheetsBuffers, x, levelY, z, 0, 1, 0, sheetColor(depth, foamAt(x, z), deepM));
    }
    sheetBoxes.push(box);
    // Triangulación del dato + puntos medios con color SOLO donde hace falta:
    // si el centroide cae dentro de la banda de espuma, el triángulo ya es todo
    // espuma y subdividir sumaría vértices sin cambiar el tono. En el vaso, en
    // cambio, el interior lleva el azul profundo que ningún vértice del borde
    // tiene. Los puntos medios se comparten entre triángulos vecinos (caché
    // por posición redondeada al cm) y su color sale SOLO de la posición, así
    // que ambos lados coinciden y no hay costuras: la espuma queda en el borde
    // exacto y el interior degrada suave al azul del vaso. (Un centroide por
    // triángulo dibujaba la red de triangulación en blanco sobre el agua.)
    const midKey = (x: number, z: number): string => `${Math.round(x * 100)},${Math.round(z * 100)}`;
    const midCache = new Map<string, number>();
    const midVertex = (ax: number, az: number, bx: number, bz: number): number => {
      const mx = (ax + bx) / 2;
      const mz = (az + bz) / 2;
      const key = midKey(mx, mz);
      const hit = midCache.get(key);
      if (hit !== undefined) return hit;
      const depth = sheetDepthAt(sheet, mx, mz);
      const vertex = pushVertex(sheetsBuffers, mx, levelY, mz, 0, 1, 0, sheetColor(depth, foamAt(mx, mz), deepM));
      midCache.set(key, vertex);
      return vertex;
    };
    for (let k = 0; k < sheet.indices.length; k += 3) {
      const i0 = base + sheet.indices[k]!;
      const i1 = base + sheet.indices[k + 1]!;
      const i2 = base + sheet.indices[k + 2]!;
      const ax = sheetsBuffers.positions[i0 * 3]!;
      const az = sheetsBuffers.positions[i0 * 3 + 2]!;
      const bx = sheetsBuffers.positions[i1 * 3]!;
      const bz = sheetsBuffers.positions[i1 * 3 + 2]!;
      const cx = sheetsBuffers.positions[i2 * 3]!;
      const cz = sheetsBuffers.positions[i2 * 3 + 2]!;
      const centerDist = edgeDist((ax + bx + cx) / 3, (az + bz + cz) / 3);
      if (centerDist <= sheet.foamM) {
        pushTri(sheetsBuffers, i0, i1, i2);
        continue;
      }
      const m01 = midVertex(ax, az, bx, bz);
      const m12 = midVertex(bx, bz, cx, cz);
      const m20 = midVertex(cx, cz, ax, az);
      pushTri(sheetsBuffers, i0, m01, m20);
      pushTri(sheetsBuffers, i1, m12, m01);
      pushTri(sheetsBuffers, i2, m20, m12);
      pushTri(sheetsBuffers, m01, m12, m20);
    }
  }

  /* ----- Malla 2: cintas ----- */

  const ribbonsBuffers = emptyBuffers();
  const ribbonGrid = new SegmentGrid(10, 8);
  for (const ribbon of data.ribbons) {
    const half = ribbon.widthM / 2;
    const points = ribbon.points;
    // Dirección por estación (diferencias centrales; un laterales en los
    // extremos). El ancho va perpendicular al eje (AGUA.md §4).
    const stationIndex: number[] = [];
    for (let i = 0; i < points.length; i++) {
      const p = points[i]!;
      const a = points[Math.max(0, i - 1)]!;
      const b = points[Math.min(points.length - 1, i + 1)]!;
      let dx = b[0] - a[0];
      let dz = b[1] - a[1];
      let len = Math.hypot(dx, dz);
      if (len < 1e-6) {
        dx = 1;
        dz = 0;
        len = 1;
      }
      const nx = (-dz / len) * half;
      const nz = (dx / len) * half;
      // Lerp TAL CUAL de los points + caladoM: es la invariante verificada
      // (>= terreno + 0,02 m en todo el eje). Nada de remuestreo propio.
      const y = toWorld(p[2] + ribbon.caladoM);
      const left = pushVertex(ribbonsBuffers, p[0] + nx, y, p[1] + nz, 0, 1, 0, RIBBON_COLOR);
      const right = pushVertex(ribbonsBuffers, p[0] - nx, y, p[1] - nz, 0, 1, 0, RIBBON_COLOR);
      stationIndex.push(left, right);
      if (i > 0) {
        const prev = points[i - 1]!;
        ribbonGrid.add(prev[0], prev[1], p[0], p[1], half, ribbon.caladoM);
      }
    }
    for (let i = 0; i + 1 < points.length; i++) {
      const l0 = stationIndex[i * 2]!;
      const r0 = stationIndex[i * 2 + 1]!;
      const l1 = stationIndex[i * 2 + 2]!;
      const r1 = stationIndex[i * 2 + 3]!;
      pushTri(ribbonsBuffers, l0, r0, l1);
      pushTri(ribbonsBuffers, r0, r1, l1);
    }
  }

  /* ----- Malla 3: presa ----- */

  const damBuffers = emptyBuffers();
  if (data.dam) {
    const dam = data.dam;
    const dx = dam.b[0] - dam.a[0];
    const dz = dam.b[1] - dam.a[1];
    const len = Math.hypot(dx, dz) || 1;
    const nx = (-dz / len) * (dam.widthM / 2);
    const nz = (dx / len) * (dam.widthM / 2);
    const yBase = toWorld(dam.baseM);
    const yCrest = toWorld(dam.crestM);
    const corner = (x: number, y: number, z: number, nnx: number, nny: number, nnz: number): number =>
      pushVertex(damBuffers, x, y, z, nnx, nny, nnz, DAM_COLOR);
    // Cara aguas arriba (+n), cara aguas abajo (−n), coronación y testeros.
    const aUp = corner(dam.a[0] + nx, yBase, dam.a[1] + nz, nx, 0, nz);
    const bUp = corner(dam.b[0] + nx, yBase, dam.b[1] + nz, nx, 0, nz);
    const bUpTop = corner(dam.b[0] + nx, yCrest, dam.b[1] + nz, nx, 0, nz);
    const aUpTop = corner(dam.a[0] + nx, yCrest, dam.a[1] + nz, nx, 0, nz);
    pushTri(damBuffers, aUp, bUp, bUpTop);
    pushTri(damBuffers, aUp, bUpTop, aUpTop);
    const aDown = corner(dam.a[0] - nx, yBase, dam.a[1] - nz, -nx, 0, -nz);
    const bDown = corner(dam.b[0] - nx, yBase, dam.b[1] - nz, -nx, 0, -nz);
    const bDownTop = corner(dam.b[0] - nx, yCrest, dam.b[1] - nz, -nx, 0, -nz);
    const aDownTop = corner(dam.a[0] - nx, yCrest, dam.a[1] - nz, -nx, 0, -nz);
    pushTri(damBuffers, aDown, bDownTop, bDown);
    pushTri(damBuffers, aDown, aDownTop, bDownTop);
    // La coronación lleva vértices PROPIOS con normal hacia arriba: reutilizar
    // los de las caras (normales horizontales sobre una cara horizontal) la
    // dejaba casi perpendicular al sol y se veía negra en la captura.
    const cAUp = corner(dam.a[0] + nx, yCrest, dam.a[1] + nz, 0, 1, 0);
    const cBUp = corner(dam.b[0] + nx, yCrest, dam.b[1] + nz, 0, 1, 0);
    const cBDown = corner(dam.b[0] - nx, yCrest, dam.b[1] - nz, 0, 1, 0);
    const cADown = corner(dam.a[0] - nx, yCrest, dam.a[1] - nz, 0, 1, 0);
    pushTri(damBuffers, cAUp, cBUp, cBDown);
    pushTri(damBuffers, cAUp, cBDown, cADown);
    const eA0 = corner(dam.a[0] + nx, yBase, dam.a[1] + nz, -dx / len, 0, -dz / len);
    const eA1 = corner(dam.a[0] - nx, yBase, dam.a[1] - nz, -dx / len, 0, -dz / len);
    const eA2 = corner(dam.a[0] - nx, yCrest, dam.a[1] - nz, -dx / len, 0, -dz / len);
    const eA3 = corner(dam.a[0] + nx, yCrest, dam.a[1] + nz, -dx / len, 0, -dz / len);
    pushTri(damBuffers, eA0, eA1, eA2);
    pushTri(damBuffers, eA0, eA2, eA3);
    const eB0 = corner(dam.b[0] + nx, yBase, dam.b[1] + nz, dx / len, 0, dz / len);
    const eB1 = corner(dam.b[0] - nx, yBase, dam.b[1] - nz, dx / len, 0, dz / len);
    const eB2 = corner(dam.b[0] - nx, yCrest, dam.b[1] - nz, dx / len, 0, dz / len);
    const eB3 = corner(dam.b[0] + nx, yCrest, dam.b[1] + nz, dx / len, 0, dz / len);
    pushTri(damBuffers, eB0, eB2, eB1);
    pushTri(damBuffers, eB0, eB3, eB2);
  }

  const meshes: Mesh[] = [];
  meshes.push(createWaterMesh(scene, 'agua:laminas', sheetsBuffers));
  meshes.push(createWaterMesh(scene, 'agua:cintas', ribbonsBuffers));
  // La cara de aguas arriba queda a contraluz del sol de mediodía: sin un
  // mínimo emisivo el hormigón se leía negro en la captura de la presa.
  if (data.dam && options.includeDam !== false) meshes.push(createWaterMesh(scene, 'agua:presa', damBuffers, [0.22, 0.22, 0.23]));

  /* ----- Consultas (AGUA.md §5.1) ----- */

  const ribbonDepthAt = (x: number, z: number): number => {
    let best = 0;
    for (const index of ribbonGrid.candidates(x, z)) {
      const seg = ribbonGrid.segments[index]!;
      if (pointSegDist(x, z, seg.ax, seg.az, seg.bx, seg.bz) <= seg.halfM && seg.caladoM > best) {
        best = seg.caladoM;
      }
    }
    return best;
  };

  const ribbonEdgeDistAt = (x: number, z: number): number => {
    let best = Infinity;
    for (const index of ribbonGrid.candidates(x, z)) {
      const seg = ribbonGrid.segments[index]!;
      const edge = pointSegDist(x, z, seg.ax, seg.az, seg.bx, seg.bz) - seg.halfM;
      if (edge < best) best = edge;
    }
    return best;
  };

  const sheetBoxesWithData = data.sheets.map((sheet, i) => ({ sheet, box: sheetBoxes[i]! }));

  function depthAt(x: number, z: number): number {
    let best = ribbonDepthAt(x, z);
    for (const { sheet, box } of sheetBoxesWithData) {
      if (x < box.minX || x > box.maxX || z < box.minZ || z > box.maxZ) continue;
      // Pertenencia al anillo SIEMPRE: la grilla del vaso tiene celdas con
      // profundidad >0 fuera del borde dibujado (21 celdas, peor 0,125 m a
      // 5 m del anillo en el gate de T4); sin este filtro `depthAt` devolvía
      // agua en seco y `nearestSafeShore` podía rechazar un punto seco.
      if (!containsPoint(sheet.ring, x, z)) continue;
      const depth =
        sheet.kind === 'reservoir'
          ? Math.max(0, gridDepthAt(x, z) ?? 0) // el vaso manda la batimetría, no nivel−terreno
          : Math.max(0, Math.min(1.5, sheet.levelM - (heightAt(x, z) + datum)));
      if (depth > best) best = depth;
    }
    return best;
  }

  /** Pendiente por diferencias finitas con `terrain.heightAt` al paso del DEM. */
  function slopeTanAt(x: number, z: number): number {
    const e = SLOPE_STEP_M;
    const hxp = heightAt(x + e, z);
    const hxm = heightAt(x - e, z);
    const hzp = heightAt(x, z + e);
    const hzm = heightAt(x, z - e);
    if (!Number.isFinite(hxp) || !Number.isFinite(hxm) || !Number.isFinite(hzp) || !Number.isFinite(hzm)) {
      return Infinity;
    }
    const gx = (hxp - hxm) / (2 * e);
    const gz = (hzp - hzm) / (2 * e);
    return Math.hypot(gx, gz);
  }

  /* ----- Grilla booleana de barro (ruling del controlador) ----- */
  //
  // DECISIÓN (ruling): la banda de <=12 m con pendiente <20° se limita a las
  // láminas (embalse/laguna/charcas); para las cintas la orilla húmeda es ~2 m.
  // Motivo: 60 cintas x 12 m pintarían el valle de barro e incluirían el camino
  // vecino a los arroyos (riesgo de que la misión se vuelva un atasco).

  const mudBox = emptyBBox();
  for (const { box } of sheetBoxesWithData) {
    growBBox(mudBox, box.minX, box.minZ);
    growBBox(mudBox, box.maxX, box.maxZ);
  }
  for (const seg of ribbonGrid.segments) {
    growBBox(mudBox, seg.ax, seg.az);
    growBBox(mudBox, seg.bx, seg.bz);
  }
  if (data.dam) {
    growBBox(mudBox, data.dam.a[0], data.dam.a[1]);
    growBBox(mudBox, data.dam.b[0], data.dam.b[1]);
  }
  mudBox.minX -= MUD_MARGIN_M;
  mudBox.maxX += MUD_MARGIN_M;
  mudBox.minZ -= MUD_MARGIN_M;
  mudBox.maxZ += MUD_MARGIN_M;
  const mudCols = Math.max(1, Math.ceil((mudBox.maxX - mudBox.minX) / MUD_CELL_M));
  const mudRows = Math.max(1, Math.ceil((mudBox.maxZ - mudBox.minZ) / MUD_CELL_M));
  const mudBits = new Uint8Array(mudCols * mudRows);
  for (let row = 0; row < mudRows; row++) {
    const z = mudBox.minZ + (row + 0.5) * MUD_CELL_M;
    for (let col = 0; col < mudCols; col++) {
      const x = mudBox.minX + (col + 0.5) * MUD_CELL_M;
      const depth = depthAt(x, z);
      // Bit 1 = barro seguro (dentro del agua o banda de lámina); bit 2 = banda
      // de cinta CANDIDATA: la celda de 4 m no puede representar la banda de
      // 2 m, así que `isMuddy` la refina con la distancia exacta al eje.
      let mud = depth >= 0.05 && depth <= 0.5 ? 1 : 0;
      if (mud === 0 && depth === 0) {
        // Orilla: 12 m de láminas o ~2 m de cintas, siempre con pendiente <20°.
        let nearSheet = false;
        for (const { sheet, box } of sheetBoxesWithData) {
          if (x < box.minX - SHEET_SHORE_M || x > box.maxX + SHEET_SHORE_M || z < box.minZ - SHEET_SHORE_M || z > box.maxZ + SHEET_SHORE_M) {
            continue;
          }
          if (containsPoint(sheet.ring, x, z)) {
            nearSheet = true; // dentro pero seco: es borde (profundidad 0)
            break;
          }
          const ring = sheet.ring;
          for (let i = 0; i < ring.length; i++) {
            const a = ring[i]!;
            const b = ring[(i + 1) % ring.length]!;
            if (pointSegDist(x, z, a[0], a[1], b[0], b[1]) <= SHEET_SHORE_M) {
              nearSheet = true;
              break;
            }
          }
          if (nearSheet) break;
        }
        const nearRibbon = !nearSheet && ribbonEdgeDistAt(x, z) <= RIBBON_SHORE_M;
        if ((nearSheet || nearRibbon) && slopeTanAt(x, z) < MAX_SLOPE_TAN) mud = nearSheet ? 1 : 2;
      }
      if (mud !== 0) mudBits[row * mudCols + col] = mud;
    }
  }

  function isMuddy(x: number, z: number): boolean {
    const col = Math.floor((x - mudBox.minX) / MUD_CELL_M);
    const row = Math.floor((z - mudBox.minZ) / MUD_CELL_M);
    if (col < 0 || row < 0 || col >= mudCols || row >= mudRows) return false;
    const bit = mudBits[row * mudCols + col];
    if (bit === 0) return false;
    if (bit === 1) return true;
    // Candidata a orilla de cinta: se refina con la distancia exacta al eje
    // (banda de ~2 m, no el tamaño de la celda) y la pendiente en el punto.
    return ribbonEdgeDistAt(x, z) <= RIBBON_SHORE_M && slopeTanAt(x, z) < MAX_SLOPE_TAN;
  }

  // Cota del mundo cargado: `heightAt` devuelve 0 fuera de los tiles, así que
  // sin esto un anillo de `nearestSafeShore` podría devolver un punto del vacío.
  const worldBox = emptyBBox();
  for (const sampler of terrain.samplers) {
    const ext = gridExtent(sampler.grid);
    growBBox(worldBox, ext.minX, ext.minZ);
    growBBox(worldBox, ext.maxX, ext.maxZ);
  }

  function nearestSafeShore(x: number, z: number): { x: number; z: number } | null {
    const STEPS = 16;
    for (let ring = 1; ring <= 6; ring++) {
      const radius = ring * 25;
      for (let k = 0; k < STEPS; k++) {
        const angle = (k / STEPS) * Math.PI * 2;
        const cx = x + Math.cos(angle) * radius;
        const cz = z + Math.sin(angle) * radius;
        if (cx < worldBox.minX || cx > worldBox.maxX || cz < worldBox.minZ || cz > worldBox.maxZ) continue;
        if (depthAt(cx, cz) !== 0) continue;
        if (slopeTanAt(cx, cz) >= MAX_SLOPE_TAN) continue;
        return { x: Math.round(cx * 100) / 100, z: Math.round(cz * 100) / 100 };
      }
    }
    return null;
  }

  const stats: WaterStats = {
    sheets: data.sheets.length,
    ribbons: data.ribbons.length,
    meshes: meshes.length,
    triangles: sheetsBuffers.triangles + ribbonsBuffers.triangles + (options.includeDam === false ? 0 : damBuffers.triangles),
    dataBytes: data.bytes,
  };

  console.info(
    `[agua] ${stats.sheets} láminas · ${stats.ribbons} cintas · ${stats.meshes} mallas · ` +
      `${stats.triangles} triángulos · ${(stats.dataBytes / 1024).toFixed(0)} KiB`,
  );

  let disposed = false;
  return {
    stats,
    depthAt,
    isMuddy,
    nearestSafeShore,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      for (const mesh of meshes) {
        const material = mesh.material;
        mesh.dispose();
        if (material) material.dispose();
      }
    },
  };
}
