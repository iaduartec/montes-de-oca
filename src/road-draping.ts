/**
 * FASE 3b — Drapeado de la red vial real sobre el terreno.
 *
 * Toma `public/roads/roads.json` (438 segmentos en coordenadas de mundo, ya
 * proyectados) y construye cintas de calzada que **siguen la superficie del
 * terreno**. No hay reproyección: los `points` ya son `[worldX, worldZ]`.
 *
 * Decisiones CERRADAS que implementa este módulo (ver docs/roads/DRAPING_FASE3B.md):
 *
 *  1. TRACK/PATH siguen el terreno vértice a vértice → residual 0 por
 *     construcción. No se aplana (aplanar costaría 0,64 m p95).
 *  2. ROAD (asfalto) lleva aplanado PARCIAL `lerp = 0,6` hacia la cota de la
 *     línea central + faldones laterales que lo cosen al terreno.
 *  3. Offset vertical de la cinta: 0,10 m (evita z-fighting sin leerse como
 *     "flotando").
 *  4. Subdivisión a 5 m (paso del DEM). Vértices OSM preservados.
 *  5. Sin suavizado longitudinal (la rugosidad es micro-relieve real).
 *  6. La pendiente transversal no se toca: la física la muestrea del terreno.
 *
 * TRAMPA (docs/vehicle/VALIDACION_FASE4.md §2): TODA altura sale de
 * `terrain.heightAt` (interpolación triangular SO→NE). Nunca se reimplementa
 * aquí la interpolación. Para verificar el residual se vuelve a llamar a
 * `terrain.heightAt`, que es la misma superficie que se dibuja.
 */

import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import type { Scene } from '@babylonjs/core/scene';

/** Clases viales del entregable de la FASE 3a. */
export type RoadClass = 'ROAD' | 'TRACK' | 'PATH';

const CLASSES: readonly RoadClass[] = ['ROAD', 'TRACK', 'PATH'];

/** Superficie del terreno que consume el drapeado (WorldTerrain la cumple). */
export interface RoadTerrain {
  heightAt(x: number, z: number): number;
  normalAt(x: number, z: number, out?: Vector3): Vector3;
}

/** Un segmento de `roads.json` (solo lo que el drapeado necesita). */
export interface RoadSource {
  readonly id: string;
  readonly class: RoadClass;
  readonly width: number;
  readonly bridge: boolean;
  readonly points: readonly (readonly [number, number])[];
}

/**
 * Constantes de geometría. Valores CERRADOS por medición previa; este objeto se
 * publica en el informe y en `pick()` para que no queden escondidos.
 */
export const DRAPING = {
  /** Paso de subdivisión a lo largo (m). Coincide con la grilla del DEM. */
  subdivisionM: 5,
  /** Fracción del aplanado ROAD hacia la cota de la línea central (0 = sigue terreno). */
  roadFlattenLerp: 0.6,
  /** Ancho del faldón lateral de ROAD, más allá del borde del asfalto (m). */
  skirtWidthM: 0.6,
  /**
   * Offset vertical de la cinta sobre el terreno (m), por clase. Escalonado
   * dentro de la ventana 0,06–0,15 m para que en los cruces (donde dos cintas
   * se solapan) gane la vía de mayor jerarquía y no queden caras coplanares.
   */
  verticalOffsetM: { ROAD: 0.12, TRACK: 0.1, PATH: 0.08 },
} as const;

/** Rol de un vértice de cinta, para poder auditar por separado. */
const ROLE_PAVEMENT = 0;
const ROLE_SKIRT = 1;
/** Vértice de puente: NO se drapea (el deck es lineal entre extremos). */
const ROLE_BRIDGE = 2;

/* ------------------------------------------------------------------------- *
 * Parseo defensivo de `roads.json`
 * ------------------------------------------------------------------------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRoadClass(value: unknown): value is RoadClass {
  return value === 'ROAD' || value === 'TRACK' || value === 'PATH';
}

function parseRoads(raw: unknown): RoadSource[] {
  if (!isRecord(raw)) throw new Error('roads: la raíz debe ser un objeto');
  const list = raw.roads;
  if (!Array.isArray(list)) throw new Error('roads: falta el array "roads"');
  const out: RoadSource[] = [];
  for (const item of list) {
    if (!isRecord(item)) continue;
    if (!isRoadClass(item.class)) continue;
    const width = item.width;
    if (typeof width !== 'number' || !Number.isFinite(width) || width <= 0) continue;
    const rawPoints = item.points;
    if (!Array.isArray(rawPoints) || rawPoints.length < 2) continue;
    const points: [number, number][] = [];
    for (const point of rawPoints) {
      if (!Array.isArray(point) || point.length < 2) continue;
      const x = point[0];
      const z = point[1];
      if (typeof x !== 'number' || typeof z !== 'number' || !Number.isFinite(x) || !Number.isFinite(z)) continue;
      points.push([x, z]);
    }
    if (points.length < 2) continue;
    out.push({
      id: typeof item.id === 'string' ? item.id : '',
      class: item.class,
      width,
      bridge: item.bridge === true,
      points,
    });
  }
  return out;
}

/* ------------------------------------------------------------------------- *
 * Subdivisión de la polilínea
 * ------------------------------------------------------------------------- */

interface Station {
  readonly x: number;
  readonly z: number;
  /** Distancia acumulada desde el inicio de la vía, en metros. */
  readonly t: number;
}

/**
 * Subdivide cada tramo OSM en pasos de a lo sumo `maxStep` metros, preservando
 * los vértices originales. El hueco máximo real de la red es 538,6 m, así que
 * esto no es opcional.
 */
function resamplePolyline(points: readonly (readonly [number, number])[], maxStep: number): Station[] {
  const stations: Station[] = [];
  let total = 0;
  const push = (x: number, z: number, t: number): void => {
    const last = stations[stations.length - 1];
    if (last && Math.abs(last.x - x) < 1e-6 && Math.abs(last.z - z) < 1e-6) return;
    stations.push({ x, z, t });
  };

  push(points[0]![0], points[0]![1], 0);
  for (let i = 1; i < points.length; i++) {
    const ax = points[i - 1]![0];
    const az = points[i - 1]![1];
    const bx = points[i]![0];
    const bz = points[i]![1];
    const segLength = Math.hypot(bx - ax, bz - az);
    if (segLength < 1e-9) continue;
    const steps = Math.max(1, Math.ceil(segLength / maxStep));
    for (let k = 1; k <= steps; k++) {
      const f = k / steps;
      push(ax + (bx - ax) * f, az + (bz - az) * f, total + segLength * f);
    }
    total += segLength;
  }
  return stations;
}

/* ------------------------------------------------------------------------- *
 * Buffers por clase
 * ------------------------------------------------------------------------- */

interface ClassBuffers {
  readonly positions: number[];
  readonly normals: number[];
  readonly colors: number[];
  readonly indices: number[];
  /** ROLE_PAVEMENT | ROLE_SKIRT, uno por vértice. */
  readonly roles: number[];
  readonly stations: { x: number; z: number; dx: number; dz: number }[];
  roadCount: number;
  triangles: number;
}

function emptyBuffers(): ClassBuffers {
  return { positions: [], normals: [], colors: [], indices: [], roles: [], stations: [], roadCount: 0, triangles: 0 };
}

interface TypedClass {
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly colors: Float32Array;
  readonly indices: Uint32Array;
  readonly roles: Uint8Array;
}

function toTyped(buffers: ClassBuffers): TypedClass {
  return {
    positions: new Float32Array(buffers.positions),
    normals: new Float32Array(buffers.normals),
    colors: new Float32Array(buffers.colors),
    indices: new Uint32Array(buffers.indices),
    roles: new Uint8Array(buffers.roles),
  };
}

/** Variación suave y determinista de color por posición (rompe la planitud). */
function vertexShade(classValue: RoadClass, x: number, z: number): number {
  const n = Math.sin(x * 0.37 + z * 0.61) * Math.cos(z * 0.29 - x * 0.53);
  const amplitude = classValue === 'ROAD' ? 0.04 : 0.12;
  const base = classValue === 'ROAD' ? 0.96 : 0.88;
  return base + amplitude * (0.5 + 0.5 * n);
}

/**
 * Construye la cinta de UNA vía dentro de sus buffers de clase.
 *
 * Layout por estación:
 *  - TRACK/PATH: `[pavL, pavR]` (2 vértices).
 *  - ROAD sin puente: `[pavL, pavR, skirtL, skirtR]` (4 vértices).
 *  - ROAD en puente: `[pavL, pavR]` sin faldones (deck lineal entre extremos).
 */
function buildRoad(buffers: ClassBuffers, road: RoadSource, terrain: RoadTerrain): void {
  const stations = resamplePolyline(road.points, DRAPING.subdivisionM);
  if (stations.length < 2) return;

  const halfWidth = road.width / 2;
  const isRoadClass = road.class === 'ROAD';
  const offset = DRAPING.verticalOffsetM[road.class];
  const useSkirt = isRoadClass && !road.bridge;
  const verticesPerStation = useSkirt ? 4 : 2;
  const baseVertex = buffers.positions.length / 3;
  const totalLength = stations[stations.length - 1]!.t || 1;
  const startY = terrain.heightAt(stations[0]!.x, stations[0]!.z);
  const endY = terrain.heightAt(stations[stations.length - 1]!.x, stations[stations.length - 1]!.z);

  const scratch = new Vector3();
  const scratchSkirt = new Vector3();
  const up = new Vector3(0, 1, 0);

  const pushVertex = (x: number, y: number, z: number, normal: Vector3, role: number): void => {
    buffers.positions.push(x, y, z);
    buffers.normals.push(normal.x, normal.y, normal.z);
    const shade = vertexShade(road.class, x, z);
    buffers.colors.push(shade, shade, shade, 1);
    buffers.roles.push(role);
  };

  for (let i = 0; i < stations.length; i++) {
    const station = stations[i]!;
    const prev = stations[Math.max(0, i - 1)]!;
    const next = stations[Math.min(stations.length - 1, i + 1)]!;
    let dx = next.x - prev.x;
    let dz = next.z - prev.z;
    let dirLength = Math.hypot(dx, dz);
    if (dirLength < 1e-6) {
      dx = 1;
      dz = 0;
      dirLength = 1;
    }
    dx /= dirLength;
    dz /= dirLength;
    // Normal izquierda: rotar el tangente +90° en el plano XZ.
    const nx = -dz;
    const nz = dx;

    const centerY = terrain.heightAt(station.x, station.z);
    const bridgeT = station.t / totalLength;

    // Altura de calzada en un punto lateral. ROAD no-puente: aplanado parcial.
    const pavementY = (px: number, pz: number): number => {
      if (road.bridge) return startY + (endY - startY) * bridgeT + offset;
      const terrainY = terrain.heightAt(px, pz);
      if (isRoadClass) {
        return terrainY + DRAPING.roadFlattenLerp * (centerY - terrainY) + offset;
      }
      return terrainY + offset;
    };

    for (const sign of [-1, 1] as const) {
      const px = station.x + nx * sign * halfWidth;
      const pz = station.z + nz * sign * halfWidth;
      const py = pavementY(px, pz);
      const normal = road.bridge ? up : terrain.normalAt(px, pz, scratch);
      pushVertex(px, py, pz, normal, road.bridge ? ROLE_BRIDGE : ROLE_PAVEMENT);
    }

    if (useSkirt) {
      for (const sign of [-1, 1] as const) {
        const lateral = sign * (halfWidth + DRAPING.skirtWidthM);
        const sx = station.x + nx * lateral;
        const sz = station.z + nz * lateral;
        // Borde libre del faldón: SIEMPRE sobre el terreno (residual 0).
        const sy = terrain.heightAt(sx, sz) + offset;
        const normal = terrain.normalAt(sx, sz, scratchSkirt);
        pushVertex(sx, sy, sz, normal, ROLE_SKIRT);
      }
    }

    buffers.stations.push({ x: station.x, z: station.z, dx, dz });
  }

  const gaps = stations.length - 1;
  const quad = (a0: number, a1: number, a2: number, a3: number): void => {
    buffers.indices.push(a0, a1, a2, a0, a2, a3);
  };
  for (let i = 0; i < gaps; i++) {
    const a = baseVertex + i * verticesPerStation;
    const b = baseVertex + (i + 1) * verticesPerStation;
    quad(a + 0, a + 1, b + 1, b + 0); // calzada
    if (useSkirt) {
      quad(a + 2, a + 0, b + 0, b + 2); // faldón izquierdo
      quad(a + 1, a + 3, b + 3, b + 1); // faldón derecho
    }
  }

  buffers.roadCount += 1;
  buffers.triangles += gaps * (useSkirt ? 6 : 2);
}

/* ------------------------------------------------------------------------- *
 * Auditoría (residual de cinta vs. terreno)
 * ------------------------------------------------------------------------- */

export interface ResidualSummary {
  readonly count: number;
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
  readonly mean: number;
  /** Vértice de mayor residual, con su cota de terreno, para depurar. */
  readonly worst: {
    readonly x: number;
    readonly y: number;
    readonly z: number;
    readonly terrainY: number;
  } | null;
}

interface ResidualSample {
  readonly r: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly terrainY: number;
}

function summarize(values: ResidualSample[]): ResidualSummary {
  if (values.length === 0) return { count: 0, p50: 0, p95: 0, max: 0, mean: 0, worst: null };
  const sorted = [...values].sort((a, b) => a.r - b.r);
  const pick = (p: number): number => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!.r;
  let sum = 0;
  for (const value of sorted) sum += value.r;
  const worst = sorted[sorted.length - 1]!;
  return {
    count: sorted.length,
    p50: pick(0.5),
    p95: pick(0.95),
    max: sorted[sorted.length - 1]!.r,
    mean: sum / sorted.length,
    worst: { x: worst.x, y: worst.y, z: worst.z, terrainY: worst.terrainY },
  };
}

export interface RoadAuditReport {
  /** Offset vertical por clase (m). */
  readonly offsetM: Record<RoadClass, number>;
  readonly toleranceM: number;
  readonly classes: Record<
    RoadClass,
    {
      /** Residual de los vértices de calzada NO puente (TRACK/PATH: ~0; ROAD: aplanado). */
      readonly pavement: ResidualSummary;
      /** Residual del borde libre del faldón (ROAD: debe llegar al terreno). */
      readonly skirt: ResidualSummary | null;
      /** Residual del deck de puente (por diseño NO se drapea). */
      readonly bridge: ResidualSummary | null;
    }
  >;
}

export interface RoadProbe {
  readonly class: RoadClass;
  readonly role: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface RoadStation {
  readonly class: RoadClass;
  readonly x: number;
  readonly z: number;
  readonly dx: number;
  readonly dz: number;
}

export interface RoadDrapingStats {
  readonly roads: number;
  readonly vertices: number;
  readonly triangles: number;
  readonly meshes: number;
  readonly byClass: Record<RoadClass, { readonly roads: number; readonly stations: number; readonly vertices: number; readonly triangles: number }>;
  readonly constants: typeof DRAPING;
  readonly bridges: number;
}

export interface RoadNetwork {
  readonly meshes: readonly Mesh[];
  readonly stats: RoadDrapingStats;
  /** Residual de TODOS los vértices de la cinta contra `terrain.heightAt`. */
  audit(): RoadAuditReport;
  /** Muestra aleatoria de vértices con su rol, para verificación independiente. */
  probe(count: number): RoadProbe[];
  /** Estaciones (centro de vía + dirección) para buscar casos difíciles. */
  stations(): RoadStation[];
  dispose(): void;
}

/* ------------------------------------------------------------------------- *
 * Materiales y malla
 * ------------------------------------------------------------------------- */

interface MaterialSpec {
  readonly name: string;
  readonly diffuse: readonly [number, number, number];
  /** Sesgo de profundidad (polygon offset). Más negativo = más al frente. */
  readonly zOffset: number;
}

const MATERIALS: Record<RoadClass, MaterialSpec> = {
  ROAD: { name: 'road:asfalto', diffuse: [0.19, 0.19, 0.2], zOffset: -3 },
  TRACK: { name: 'road:tierra', diffuse: [0.4, 0.32, 0.22], zOffset: -2 },
  PATH: { name: 'road:senda', diffuse: [0.52, 0.47, 0.34], zOffset: -1 },
};

function createMaterial(scene: Scene, spec: MaterialSpec): StandardMaterial {
  const material = new StandardMaterial(spec.name, scene);
  material.diffuseColor = new Color3(spec.diffuse[0], spec.diffuse[1], spec.diffuse[2]);
  material.specularColor = new Color3(0.04, 0.04, 0.04);
  material.ambientColor = new Color3(0.22, 0.22, 0.22);
  material.backFaceCulling = false;
  // Polygon offset: compensa la pérdida de precisión de profundidad a distancia
  // (los offsets geométricos son menores que la resolución de depth a ~1 km).
  // El escalón por clase también define quién gana en los cruces.
  material.zOffset = spec.zOffset;
  material.freeze();
  return material;
}

function createMesh(scene: Scene, name: string, data: TypedClass, material: StandardMaterial): Mesh {
  const vertexData = new VertexData();
  vertexData.positions = data.positions;
  vertexData.normals = data.normals;
  vertexData.colors = data.colors;
  vertexData.indices = data.indices;
  const mesh = new Mesh(name, scene);
  vertexData.applyToMesh(mesh, false);
  mesh.material = material;
  mesh.useVertexColors = true;
  mesh.receiveShadows = true;
  mesh.isPickable = false;
  mesh.freezeWorldMatrix();
  return mesh;
}

/* ------------------------------------------------------------------------- *
 * Carga
 * ------------------------------------------------------------------------- */

export interface LoadRoadNetworkOptions {
  readonly url?: string;
  readonly fetchImpl?: typeof fetch;
  /**
   * Dominio del terreno `[minX, maxX] × [minZ, maxZ]`. Si se pasa, las
   * coordenadas de muestreo se recortan a él: `terrain.heightAt` devuelve el
   * "0 absoluto" (−datum) fuera de la ventana y eso clavaría un pico artificial
   * en los bordes del mundo.
   */
  readonly bounds?: { readonly minX: number; readonly maxX: number; readonly minZ: number; readonly maxZ: number };
}

function clampToBounds(bounds: LoadRoadNetworkOptions['bounds'], terrain: RoadTerrain): RoadTerrain {
  if (!bounds) return terrain;
  const clamp = (v: number, min: number, max: number): number => (v < min ? min : v > max ? max : v);
  const heightAt = (x: number, z: number): number => terrain.heightAt(clamp(x, bounds.minX, bounds.maxX), clamp(z, bounds.minZ, bounds.maxZ));
  const normalAt = (x: number, z: number, out?: Vector3): Vector3 =>
    terrain.normalAt(clamp(x, bounds.minX, bounds.maxX), clamp(z, bounds.minZ, bounds.maxZ), out);
  return { heightAt, normalAt };
}

/**
 * Carga y drapea TODA la red. Construye una malla por clase (≤3 draw calls),
 * con vertex data propia (sin `MergeMeshes`, para no clonar buffers).
 */
export async function loadRoadNetwork(
  scene: Scene,
  terrain: RoadTerrain,
  options: LoadRoadNetworkOptions = {},
): Promise<RoadNetwork> {
  const url = options.url ?? '/roads/roads.json';
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(url);
  if (!response.ok) throw new Error(`roads: no se pudo cargar ${url} (HTTP ${response.status})`);
  const roads = parseRoads((await response.json()) as unknown);

  const surface = clampToBounds(options.bounds, terrain);

  const buffers: Record<RoadClass, ClassBuffers> = {
    ROAD: emptyBuffers(),
    TRACK: emptyBuffers(),
    PATH: emptyBuffers(),
  };
  let bridges = 0;
  for (const road of roads) {
    if (road.bridge) bridges += 1;
    buildRoad(buffers[road.class], road, surface);
  }

  const typed: Record<RoadClass, TypedClass> = {
    ROAD: toTyped(buffers.ROAD),
    TRACK: toTyped(buffers.TRACK),
    PATH: toTyped(buffers.PATH),
  };

  const materials: Record<RoadClass, StandardMaterial> = {
    ROAD: createMaterial(scene, MATERIALS.ROAD),
    TRACK: createMaterial(scene, MATERIALS.TRACK),
    PATH: createMaterial(scene, MATERIALS.PATH),
  };

  const meshes: Mesh[] = [];
  for (const cls of CLASSES) {
    if (typed[cls].indices.length === 0) continue;
    meshes.push(createMesh(scene, `vias:${cls}`, typed[cls], materials[cls]));
  }

  let vertexCount = 0;
  let triangleCount = 0;
  const byClass = {} as RoadDrapingStats['byClass'];
  for (const cls of CLASSES) {
    const b = buffers[cls];
    const classVertices = b.positions.length / 3;
    vertexCount += classVertices;
    triangleCount += b.triangles;
    byClass[cls] = { roads: b.roadCount, stations: b.stations.length, vertices: classVertices, triangles: b.triangles };
  }

  const stats: RoadDrapingStats = {
    roads: roads.length,
    vertices: vertexCount,
    triangles: triangleCount,
    meshes: meshes.length,
    byClass,
    constants: DRAPING,
    bridges,
  };

  const audit = (): RoadAuditReport => {
    const classes = {} as RoadAuditReport['classes'];
    for (const cls of CLASSES) {
      const positions = typed[cls].positions;
      const roles = typed[cls].roles;
      const offset = DRAPING.verticalOffsetM[cls];
      const pavement: ResidualSample[] = [];
      const skirt: ResidualSample[] = [];
      const bridge: ResidualSample[] = [];
      for (let i = 0, v = 0; i < positions.length; i += 3, v++) {
        const x = positions[i]!;
        const y = positions[i + 1]!;
        const z = positions[i + 2]!;
        const terrainY = surface.heightAt(x, z);
        const sample: ResidualSample = { r: Math.abs(y - (terrainY + offset)), x, y, z, terrainY };
        const role = roles[v];
        if (role === ROLE_SKIRT) skirt.push(sample);
        else if (role === ROLE_BRIDGE) bridge.push(sample);
        else pavement.push(sample);
      }
      classes[cls] = {
        pavement: summarize(pavement),
        skirt: skirt.length > 0 ? summarize(skirt) : null,
        bridge: bridge.length > 0 ? summarize(bridge) : null,
      };
    }
    return { offsetM: { ...DRAPING.verticalOffsetM }, toleranceM: 1e-3, classes };
  };

  const probe = (count: number): RoadProbe[] => {
    const out: RoadProbe[] = [];
    for (let i = 0; i < count; i++) {
      const cls = CLASSES[Math.floor(Math.random() * CLASSES.length)]!;
      const positions = typed[cls].positions;
      const roles = typed[cls].roles;
      const vertex = Math.floor(Math.random() * (positions.length / 3));
      out.push({
        class: cls,
        role: roles[vertex]!,
        x: positions[vertex * 3]!,
        y: positions[vertex * 3 + 1]!,
        z: positions[vertex * 3 + 2]!,
      });
    }
    return out;
  };

  const stations = (): RoadStation[] => {
    const out: RoadStation[] = [];
    for (const cls of CLASSES) {
      for (const station of buffers[cls].stations) {
        out.push({ class: cls, x: station.x, z: station.z, dx: station.dx, dz: station.dz });
      }
    }
    return out;
  };

  return {
    meshes,
    stats,
    audit,
    probe,
    stations,
    dispose: () => {
      for (const mesh of meshes) mesh.dispose();
      for (const cls of CLASSES) materials[cls].dispose();
    },
  };
}
