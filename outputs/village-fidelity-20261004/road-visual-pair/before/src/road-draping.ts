/** Road ribbons follow a separately sampled, bounded driving profile.
 * OSM XZ, footprint trims and bridge deck semantics remain unchanged.
 * Wheel contacts query the final rendered triangles through RoadNetwork.surface. */

import { buildRoadProfile } from './road-profile';
import { createRenderedRoadSurface, type RoadSurfaceSampler } from './world/road-surface';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import type { Scene } from '@babylonjs/core/scene';
import {
  parseSpeedLimitKph,
  ROAD_CLEARANCE_SAMPLES,
  ROAD_SURFACE_CLEARANCE_M,
  roadVertexHue,
  roadVertexShade,
  shouldMarkRoad,
  shouldPlaceSpeedSign,
} from './road-visuals';

/** Clases viales del entregable de la FASE 3a. */
export type RoadClass = 'ROAD' | 'TRACK' | 'PATH';

export interface RoadMapLine {
  readonly id: string;
  readonly class: RoadClass;
  readonly points: readonly (readonly [number, number])[];
  /** Actual OSM/design width and trimmed bands, also used by wheel surfaces. */
  readonly width: number;
  readonly clearance?: ClearanceProfile | null;
}

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
  readonly ref?: string;
  readonly maxspeed?: unknown;
  readonly points: readonly (readonly [number, number])[];
  /**
   * Perfil de semiancho EXTERIOR (calzada + faldón) por estación, publicado por
   * `build_roads.py` solo cuando la banda se recortó cerca de una huella. Si
   * falta, se usa el ancho de diseño constante `width/2` (+ faldón en ROAD).
   */
  readonly clearance?: ClearanceProfile | null;
}

/**
 * Perfil asimétrico de la banda dibujada. `bandLeft[k]`/`bandRight[k]` son el
 * semiancho EXTERIOR total en la estación `k`, muestreado cada `stepM` metros
 * de distancia acumulada desde el inicio de la vía. El renderer interpola por
 * distancia y deriva calzada (`band - skirtM`) y faldón. `renderStepM` es la
 * subdivisión transversal mínima que garantiza que la interpolación no
 * recupere el ancho completo entre dos estaciones recortadas.
 */
export interface ClearanceProfile {
  readonly stepM: number;
  readonly renderStepM: number;
  readonly skirtM: number;
  readonly bandLeft: readonly number[];
  readonly bandRight: readonly number[];
}

/**
 * Constantes de geometría. Valores CERRADOS por medición previa; este objeto se
 * publica en el informe y en `pick()` para que no queden escondidos.
 */
export const DRAPING = {
  /** Paso de subdivisión a lo largo (m). Coincide con la grilla del DEM. */
  subdivisionM: 2.5,
  /** Fracción del aplanado ROAD hacia la cota de la línea central (0 = sigue terreno). */
  roadFlattenLerp: 0.6,
  /** Separación transversal máxima entre vértices de calzada (m). */
  crossSectionSpacingM: 1.5,
  /** Separación libre mínima contra el DEM dentro de cada triángulo (m). */
  surfaceClearanceM: ROAD_SURFACE_CLEARANCE_M,
  /** Ancho del faldón lateral de ROAD, más allá del borde del asfalto (m). */
  skirtWidthM: 0.6,
  /**
   * Offset vertical de la cinta sobre el terreno (m), por clase. Escalonado
   * dentro de la ventana 0,06–0,15 m para que en los cruces (donde dos cintas
   * se solapan) gane la vía de mayor jerarquía y no queden caras coplanares.
   */
  verticalOffsetM: { ROAD: 0.12, TRACK: 0.1, PATH: 0.08 },
  /**
   * Cota del borde libre de los faldones (m). Con el MDT recortado debe
   * coincidir con el terreno: un lift dejaría una rendija visible al cielo.
   */
  skirtLiftM: 0,
} as const;
/** Cota del faldón: banda de mezcla apoyada en el terreno, nunca superficie de rodadura. */
const SKIRT_LIFT_M = DRAPING.skirtLiftM;
/**
 * Tiras laterales del detalle de rodadas de una pista (fracción del semiancho y tinte
 * R/G/B). Su largo fija la fila transversal de esos tramos: la malla reserva exactamente
 * esta cantidad de vértices por estación para que el detalle y la malla base compartan
 * el mismo avance por hueco.
 */
const TRACK_SECTION: readonly (readonly [number, number, number, number])[] = [
  [-1, 1.02, 1.04, 0.92],
  [-0.82, 1.02, 1.02, 0.94],
  [-0.61, 0.88, 0.89, 0.88],
  [-0.37, 0.88, 0.89, 0.88],
  [0, 1.03, 1.02, 0.97],
  [0.37, 0.88, 0.89, 0.88],
  [0.61, 0.88, 0.89, 0.88],
  [0.82, 1.02, 1.02, 0.94],
  [1, 1.02, 1.04, 0.92],
];

/** Rol de un vértice de cinta, para poder auditar por separado. */
const ROLE_PAVEMENT = 0;
const ROLE_SKIRT = 1;
/** Vértice de puente: NO se drapea (el deck es lineal entre extremos). */
const ROLE_BRIDGE = 2;
/** Señal vertical en el buffer ROAD: no se incluye en auditorías del pavimento. */
const ROLE_SIGN = 3;

/* ------------------------------------------------------------------------- *
 * Parseo defensivo de `roads.json`
 * ------------------------------------------------------------------------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRoadClass(value: unknown): value is RoadClass {
  return value === 'ROAD' || value === 'TRACK' || value === 'PATH';
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Parseo defensivo del perfil de recorte. Devuelve null ante cualquier forma
 * inesperada: el renderer cae al ancho de diseño y el validador de datos es
 * quien debe detectar el JSON inválido, no un fallo silencioso en runtime.
 */
function parseClearance(raw: unknown): ClearanceProfile | null {
  if (!isRecord(raw)) return null;
  const { stepM, renderStepM, skirtM, bandLeft, bandRight } = raw;
  if (!isFiniteNumber(stepM) || stepM <= 0) return null;
  if (!isFiniteNumber(renderStepM) || renderStepM <= 0) return null;
  if (!isFiniteNumber(skirtM) || skirtM < 0) return null;
  if (!Array.isArray(bandLeft) || !Array.isArray(bandRight)) return null;
  if (bandLeft.length < 2 || bandLeft.length !== bandRight.length) return null;
  const left: number[] = [];
  const right: number[] = [];
  for (let i = 0; i < bandLeft.length; i++) {
    const l = bandLeft[i];
    const r = bandRight[i];
    if (!isFiniteNumber(l) || !isFiniteNumber(r) || l < 0 || r < 0) return null;
    left.push(l);
    right.push(r);
  }
  return { stepM, renderStepM, skirtM, bandLeft: left, bandRight: right };
}

/**
 * Interpola `(bandLeft, bandRight)` del perfil por distancia acumulada `t`.
 * Reproduce EXACTAMENTE `profile_at` de `build_roads.py`: mismo `floor`/`lerp`
 * sobre `stepM` y mismo recorte a la última estación. Así el validador de datos
 * y la malla consultan el perfil estación a estación con la misma aritmética.
 */
function profileAt(profile: ClearanceProfile, t: number): readonly [number, number] {
  const last = profile.bandLeft.length - 1;
  const pos = Math.max(0, t) / profile.stepM;
  const i0 = Math.floor(pos);
  if (i0 >= last) return [profile.bandLeft[last]!, profile.bandRight[last]!];
  const f = pos - i0;
  return [
    profile.bandLeft[i0]! * (1 - f) + profile.bandLeft[i0 + 1]! * f,
    profile.bandRight[i0]! * (1 - f) + profile.bandRight[i0 + 1]! * f,
  ];
}

/** Límites laterales vigentes en una estación (metros desde el eje). */
interface StationBand {
  /** Semiancho de calzada por lado, ya recortado a `[0, width/2]`. */
  readonly pavementLeft: number;
  readonly pavementRight: number;
  /** Banda EXTERIOR por lado (calzada + faldón) hasta donde se dibuja. */
  readonly outerLeft: number;
  readonly outerRight: number;
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
    const tags = isRecord(item.tags) ? item.tags : null;
    const ref = typeof item.ref === 'string' ? item.ref : (typeof tags?.ref === 'string' ? tags.ref : undefined);
    const maxspeed = tags?.maxspeed;
    out.push({
      id: typeof item.id === 'string' ? item.id : '',
      class: item.class,
      width,
      bridge: item.bridge === true,
      ...(ref === undefined ? {} : { ref }),
      ...(maxspeed === undefined ? {} : { maxspeed }),
      points,
      clearance: parseClearance(item.clearance),
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
  readonly tangents: number[];
  readonly footprint: number[];
  readonly terminals: { vertices: number[]; road: number; x: number; z: number }[];
  readonly owners: number[];
  readonly roadIds: string[];
  readonly profileGroups: { vertices: number[]; t: number; road: number; cls: RoadClass; x: number; z: number; width: number }[];
  readonly stations: { x: number; z: number; dx: number; dz: number }[];
  roadCount: number;
  triangles: number;
  signs: number;
}

function emptyBuffers(): ClassBuffers {
  return { terminals: [], owners: [], roadIds: [], footprint: [], tangents: [], profileGroups: [], positions: [], normals: [], colors: [], indices: [], roles: [], stations: [], roadCount: 0, triangles: 0, signs: 0 };
}

interface TypedClass {
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly colors: Float32Array;
  indices: Uint32Array;
  readonly roles: Uint8Array;
  readonly tangents: Float32Array;
  readonly roadOrdinal: Uint32Array;
  readonly roadIds: readonly string[];
}

interface LocalPolishZone {
  readonly x: number;
  readonly z: number;
  readonly radiusM: number;
}

function toTyped(buffers: ClassBuffers): TypedClass {
  return {
    positions: new Float32Array(buffers.positions),
    normals: new Float32Array(buffers.normals),
    colors: new Float32Array(buffers.colors),
    indices: new Uint32Array(buffers.indices),
    roles: new Uint8Array(buffers.roles),
    tangents: new Float32Array(buffers.tangents),
    roadOrdinal: new Uint32Array(buffers.owners),
    roadIds: buffers.roadIds,
  };
}

/**
 * Construye la cinta de UNA vía dentro de sus buffers de clase.
 *
 * Layout por estación:
 *  - TRACK/PATH: `[pavL, pavR]` (2 vértices).
 *  - Vía sin puente: secciones transversales de hasta 1,5 m.
 *  - ROAD sin puente: las secciones + 2 de faldón.
 *  - ROAD en puente: `[pavL, pavR]` sin faldones (deck lineal entre extremos).
 */
function buildRoad(
  buffers: ClassBuffers,
  road: RoadSource,
  terrain: RoadTerrain,
  trackPolish?: LocalPolishZone,
  roadPolish?: LocalPolishZone,
  _blendCorridor?: LoadRoadNetworkOptions['trackBlendCorridor'],
): void {
  const clearance = road.clearance ?? null;
  // Solo las vías con perfil de recorte se subdividen al paso fino publicado
  // (`min(subdivisionM, renderStepM)`), para que la interpolación no recupere
  // ancho entre estaciones. El resto conserva EXACTAMENTE la malla histórica.
  const maxStep = clearance
    ? Math.min(DRAPING.subdivisionM, clearance.renderStepM)
    : DRAPING.subdivisionM;
  const stations = resamplePolyline(road.points, maxStep);
  if (stations.length < 2) return;

  const halfWidth = road.width / 2;
  const isRoadClass = road.class === 'ROAD';
  const isTrackClass = road.class === 'TRACK';
  const offset = DRAPING.verticalOffsetM[road.class];
  /**
   * El detalle de rodadas de la pista se decide por VÍA, no por hueco: si el layout
   * cambiara a mitad de vía, los índices que avanza `i * verticesPerStation` dejarían
   * de coincidir con los vértices realmente escritos y los huecos siguientes se
   * dibujarían con vértices de estaciones anteriores (malla sesgada).
   */
  const detallePista = isTrackClass && !road.bridge && trackPolish !== undefined &&
    Number.isFinite(trackPolish.radiusM) && trackPolish.radiusM > 0 &&
    stations.some(
      (station) =>
        Math.hypot(station.x - trackPolish.x, station.z - trackPolish.z) <= trackPolish.radiusM + DRAPING.subdivisionM,
    );
  // La pista de tierra también recibe faldón de mezcla, pero solo en el corredor de la
  // ruta jugable (ver `trackBlendCorridor`) y nunca en los tramos con rodadas detalladas.
  const useSkirt = !road.bridge;

  /**
   * Límites laterales por estación. Sin perfil devuelve la calzada `width/2` y
   * el faldón de diseño a ambos lados (idéntico al histórico). Con perfil,
   * recorta la calzada a `band - skirt` (clamp `[0, width/2]`) y deja el faldón
   * hasta la banda EXTERIOR publicada.
   */
  const bandAt = (t: number): StationBand => {
    if (!clearance) {
      const outer = halfWidth + DRAPING.skirtWidthM;
      return { pavementLeft: halfWidth, pavementRight: halfWidth, outerLeft: outer, outerRight: outer };
    }
    const [outerLeft, outerRight] = profileAt(clearance, t);
    const skirt = clearance.skirtM;
    return {
      pavementLeft: Math.max(0, Math.min(halfWidth, outerLeft - skirt)),
      pavementRight: Math.max(0, Math.min(halfWidth, outerRight - skirt)),
      outerLeft,
      outerRight,
    };
  };
  const profile = road.bridge ? null : buildRoadProfile(stations, stations.map(s => bandAt(s.t)), terrain, road.class);
  const groups = stations.map(s => ({ vertices: [] as number[], t: s.t, road: buffers.roadCount, cls: road.class, x: s.x, z: s.z, width: road.width }));
  buffers.profileGroups.push(...groups);
  let activeStation = 0;
  const sectionCount = road.bridge ? 2 : Math.max(3, Math.ceil(road.width / DRAPING.crossSectionSpacingM) + 1);
  // Con rodadas detalladas la fila usa exactamente las tiras de TRACK_SECTION; sin
  // perfil, la retícula transversal de siempre. Ambas rutas reservan el mismo número
  // de vértices por estación, así el avance por `i * verticesPerStation` no se desvía.
  const pavementVertices = detallePista ? TRACK_SECTION.length : sectionCount % 2 === 0 ? sectionCount + 1 : sectionCount;
  const verticesPerStation = pavementVertices + (useSkirt ? 2 : 0);
  const baseVertex = buffers.positions.length / 3;
  const totalLength = stations[stations.length - 1]!.t || 1;
  const startY = terrain.heightAt(stations[0]!.x, stations[0]!.z);
  const endY = terrain.heightAt(stations[stations.length - 1]!.x, stations[stations.length - 1]!.z);

  const scratch = new Vector3();
  const scratchSkirt = new Vector3();
  const up = new Vector3(0, 1, 0);

  const pushVertex = (x: number, y: number, z: number, normal: Vector3, role: number, tint?: readonly [number, number, number]): void => {
    if (role === ROLE_PAVEMENT || role === ROLE_BRIDGE || role === 4) groups[activeStation]!.vertices.push(buffers.positions.length / 3);
    buffers.positions.push(x, y, z);
    buffers.normals.push(normal.x, normal.y, normal.z);
    const shade = roadVertexShade(road.class, x, z);
    const hue = roadVertexHue(road.class, x, z);
    buffers.colors.push(
      shade * hue[0] * (tint?.[0] ?? 1),
      shade * hue[1] * (tint?.[1] ?? 1),
      shade * hue[2] * (tint?.[2] ?? 1),
      1,
    );
    buffers.roles.push(role);
    buffers.owners.push(buffers.roadCount);
    const previous = stations[Math.max(0, activeStation - 1)]!, next = stations[Math.min(stations.length - 1, activeStation + 1)]!;
    const length = Math.hypot(next.x - previous.x, next.z - previous.z) || 1;
    buffers.tangents.push((next.x - previous.x) / length, (next.z - previous.z) / length);
  };

  for (let i = 0; i < stations.length; i++) {
    activeStation = i;
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

    const centerY = profile?.[i]?.centerHeight ?? terrain.heightAt(station.x, station.z);
    const bridgeT = station.t / totalLength;

    // Altura de calzada en un punto lateral. ROAD no-puente: aplanado parcial.
    const pavementY = (px: number, pz: number): number => {
      if (road.bridge) return startY + (endY - startY) * bridgeT + offset;
      const lateral = (px - station.x) * nx + (pz - station.z) * nz;
      return centerY + profile![i]!.desiredBank * lateral + offset;
    };

    const band = bandAt(station.t);
    for (let section = 0; section < pavementVertices; section++) {
      const fraction = -1 + 2 * section / (pavementVertices - 1);
      const sideHalf = fraction < 0 ? band.pavementRight : band.pavementLeft;
      const px = station.x + nx * fraction * sideHalf;
      const pz = station.z + nz * fraction * sideHalf;
      const py = pavementY(px, pz);
      const normal = road.bridge ? up : terrain.normalAt(px, pz, scratch);
      // Dos bandas oscuras siguen la línea de rodadura a ambos lados; con la
      // cresta central más clara, la pista deja de leerse como una cinta lisa.
      const rut = isTrackClass ? Math.exp(-(((Math.abs(fraction) - 0.48) / 0.2) ** 2)) : 0;
      const rutTint: readonly [number, number, number] = [1 - 0.18 * rut, 1 - 0.13 * rut, 1 - 0.08 * rut];
      pushVertex(px, py, pz, normal, road.bridge ? ROLE_BRIDGE : ROLE_PAVEMENT, isTrackClass ? rutTint : undefined);
    }

    if (useSkirt) {
      for (const sign of [-1, 1] as const) {
        // El faldón llega hasta la banda EXTERIOR publicada (no a `half + skirt`).
        const lateral = sign * (sign < 0 ? band.outerRight : band.outerLeft);
        const sx = station.x + nx * lateral;
        const sz = station.z + nz * lateral;
        // Borde libre del faldón: SIEMPRE sobre el terreno (residual 0).
        // Banda de mezcla apoyada en el terreno: SIEMPRE por debajo de cualquier
        // calzada (offset de clase 0.12 y aplanado por encima). Con la misma cota que
        // una calzada (aplanado nulo) los faldones de vías que se cruzan quedaban
        // coplanares y el z-buffer pintaba franjas de tierra sobre el asfalto.
        const sy = terrain.heightAt(sx, sz) + SKIRT_LIFT_M;
        const normal = terrain.normalAt(sx, sz, scratchSkirt);
        // La tierra cálida en el borde libre disuelve la línea gris del asfalto, pero
        // suave: un tinte fuerte se leía como una franja de tierra pintada en la calle.
        // En la pista de tierra, en cambio, el margen va hacia el pasto seco.
        const tinte: readonly [number, number, number] = isRoadClass ? [1.22, 1.12, 0.94] : [0.85, 1.02, 0.72];
        pushVertex(sx, sy, sz, normal, ROLE_SKIRT, tinte);
      }
    }

    buffers.stations.push({ x: station.x, z: station.z, dx, dz });
  }

  const gaps = stations.length - 1;
  const quad = (a0: number, a1: number, a2: number, a3: number): void => {
    buffers.indices.push(a0, a1, a2, a0, a2, a3);
  };
  let polishedGaps = 0;
  // Tonos de sección: borde terroso, hombro, rodada, franja central y simetría.
  // Cada franja sigue terrain.heightAt; no modifica las cotas ni la física.
  const appendTrackSection = (stationIndex: number, strength: number): number => {
    activeStation = stationIndex;
    const station = stations[stationIndex]!;
    const direction = buffers.stations[buffers.stations.length - stations.length + stationIndex]!;
    const nx = -direction.dz;
    const nz = direction.dx;
    const band = bandAt(station.t);
    const first = buffers.positions.length / 3;
    for (const [fraction, red, green, blue] of TRACK_SECTION) {
      const sideHalf = fraction < 0 ? band.pavementRight : band.pavementLeft;
      const x = station.x + nx * fraction * sideHalf;
      const z = station.z + nz * fraction * sideHalf;
      const tint: readonly [number, number, number] = [
        1 + (red - 1) * strength,
        1 + (green - 1) * strength,
        1 + (blue - 1) * strength,
      ];
      pushVertex(x, profile![stationIndex]!.centerHeight + profile![stationIndex]!.desiredBank * fraction * sideHalf + offset, z, terrain.normalAt(x, z, scratch), ROLE_PAVEMENT, tint);
    }
    return first;
  };
  // Las marcas se dibujan como líneas estrechas encima de la calzada base. Antes
  // se reemplazaba toda su superficie por una cinta con muchas franjas laterales;
  // en móvil esa malla dejaba escapar el DEM y se veían bandas verdes en el asfalto.
  const appendRoadMark = (
    startStation: number,
    endStation: number,
    from: number,
    to: number,
    color: readonly [number, number, number],
    strength: number,
  ): void => {
    const first = buffers.positions.length / 3;
    for (const stationIndex of [startStation, endStation]) {
      activeStation = stationIndex;
      const station = stations[stationIndex]!;
      const direction = buffers.stations[buffers.stations.length - stations.length + stationIndex]!;
      const nx = -direction.dz;
      const nz = direction.dx;
      const band = bandAt(station.t);
      const centerY = profile![stationIndex]!.centerHeight;
      for (const fraction of [from, to]) {
        const sideHalf = fraction < 0 ? band.pavementRight : band.pavementLeft;
        const x = station.x + nx * fraction * sideHalf;
        const z = station.z + nz * fraction * sideHalf;
        const y = centerY + profile![stationIndex]!.desiredBank * fraction * sideHalf + offset + 0.025;
        const tint: readonly [number, number, number] = [
          1 + (color[0] - 1) * strength,
          1 + (color[1] - 1) * strength,
          1 + (color[2] - 1) * strength,
        ];
        pushVertex(x, y, z, terrain.normalAt(x, z, scratch), 4, tint);
      }
    }
    quad(first, first + 1, first + 3, first + 2);
  };
  let polishedRoadGaps = 0;
  const markedRoad = shouldMarkRoad(road);
  for (let i = 0; i < gaps; i++) {
    const a = baseVertex + i * verticesPerStation;
    const b = baseVertex + (i + 1) * verticesPerStation;
    const midpointX = (stations[i]!.x + stations[i + 1]!.x) / 2;
    const midpointZ = (stations[i]!.z + stations[i + 1]!.z) / 2;
    const trackPolishDistance = trackPolish ? Math.hypot(midpointX - trackPolish.x, midpointZ - trackPolish.z) : Infinity;
    const detailedTrack = road.class === 'TRACK' && !road.bridge && trackPolish &&
      Number.isFinite(trackPolish.radiusM) && trackPolish.radiusM > 0 &&
      trackPolishDistance <= trackPolish.radiusM;
    const roadPolishDistance = roadPolish ? Math.hypot(midpointX - roadPolish.x, midpointZ - roadPolish.z) : Infinity;
    const detailedRoad = markedRoad || (road.class === 'ROAD' && !road.bridge && road.width >= 6.5 && roadPolish &&
      Number.isFinite(roadPolish.radiusM) && roadPolish.radiusM > 0 && roadPolishDistance <= roadPolish.radiusM);
    if (detailedTrack) {
      const strength = Math.min(1, Math.max(0, (trackPolish.radiusM - trackPolishDistance) / 25));
      const first = appendTrackSection(i, strength);
      const second = appendTrackSection(i + 1, strength);
      for (let strip = 0; strip < TRACK_SECTION.length - 1; strip++) {
        quad(first + strip, first + strip + 1, second + strip + 1, second + strip);
      }
      polishedGaps++;
    } else {
      // La superficie continua siempre usa la misma retícula y cota base.
      for (let strip = 0; strip < pavementVertices - 1; strip++) {
        quad(a + strip, a + strip + 1, b + strip + 1, b + strip);
      }
    }
    if (!detailedTrack && detailedRoad) {
      const dash = ((stations[i]!.t + stations[i + 1]!.t) / 2) % 12 < 4;
      const strength = markedRoad ? 1 : Math.min(1, Math.max(0, ((roadPolish?.radiusM ?? 0) - roadPolishDistance) / 25));
      appendRoadMark(i, i + 1, -0.96, -0.92, [3.8, 3.7, 3.5], strength);
      appendRoadMark(i, i + 1, 0.92, 0.96, [3.8, 3.7, 3.5], strength);
      if (dash) appendRoadMark(i, i + 1, -0.012, 0.012, [4.6, 4.4, 3.8], strength);
      polishedRoadGaps++;
    }
    if (useSkirt) {
      quad(a + pavementVertices, a + 0, b + 0, b + pavementVertices); // faldón izquierdo
      quad(a + pavementVertices - 1, a + pavementVertices + 1, b + pavementVertices + 1, b + pavementVertices - 1); // faldón derecho
    }
  }

  if (!road.bridge) {
    const left = useSkirt ? pavementVertices : 0;
    const right = useSkirt ? pavementVertices + 1 : pavementVertices - 1;
    const point = (row: number, side: number): readonly [number, number] => {
      const v = baseVertex + row * verticesPerStation + side;
      return [buffers.positions[v * 3]!, buffers.positions[v * 3 + 2]!];
    };
    const linear = (start: number, middle: number, end: number, side: number): boolean => {
      const a = point(start, side), b = point(middle, side), c = point(end, side);
      const dx = c[0] - a[0], dz = c[1] - a[1], length = Math.hypot(dx, dz);
      if (length < 1e-8 || length > 100) return false;
      const along = ((b[0] - a[0]) * dx + (b[1] - a[1]) * dz) / (length * length);
      return along >= 0 && along <= 1 && Math.abs(dx * (b[1] - a[1]) - dz * (b[0] - a[0])) / length < 1e-7;
    };
    // Dissolve only collinear boundary vertices. Bends and clearance-width
    // changes stay exact; this does not simplify any rendered road geometry.
    for (let start = 0; start < gaps;) {
      let end = start + 1;
      while (end < gaps && linear(start, end, end + 1, left) && linear(start, end, end + 1, right)) end++;
      const a = point(start, left), b = point(start, right), c = point(end, right), d = point(end, left);
      const corners = [a,b,c,d];
      const turns = corners.map((p,i)=>{const q=corners[(i+1)%4]!,r=corners[(i+2)%4]!;return (q[0]-p[0])*(r[1]-q[1])-(q[1]-p[1])*(r[0]-q[0]);});
      if (turns.every(t=>t>=-1e-9)||turns.every(t=>t<=1e-9)) {
        for (const p of [a,b,c,a,c,d]) buffers.footprint.push(...p);
      } else {
        // Folded or concave station quads (hairpins/trimmed corners) cannot
        // dissolve transverse edges: retain the exact mesh triangle union.
        const emit = (v: number): void => { buffers.footprint.push(buffers.positions[v*3]!,buffers.positions[v*3+2]!); };
        for(let row=start;row<end;row++){
          const va=baseVertex+row*verticesPerStation,vb=va+verticesPerStation;
          const quadFoot=(a:number,b:number,c:number,d:number):void=>{for(const v of [a,b,c,a,c,d])emit(v);};
          for(let strip=0;strip<pavementVertices-1;strip++)quadFoot(va+strip,va+strip+1,vb+strip+1,vb+strip);
          if(useSkirt){quadFoot(va+pavementVertices,va,vb,vb+pavementVertices);quadFoot(va+pavementVertices-1,va+pavementVertices+1,vb+pavementVertices+1,vb+pavementVertices-1);}
        }
      }
      start = end;
    }
  }

  // Señales de velocidad con geometría low-poly integrada en el único buffer
  // de ROAD. Solo se usan límites numéricos presentes en los metadatos OSM.
  const speedLimit = parseSpeedLimitKph(road.maxspeed);
  if (speedLimit !== null && shouldPlaceSpeedSign(road, totalLength)) {
    const stationIndex = Math.floor((stations.length - 1) / 2);
    const station = stations[stationIndex]!;
    const direction = buffers.stations[buffers.stations.length - stations.length + stationIndex]!;
    const nx = -direction.dz;
    const nz = direction.dx;
    const band = bandAt(station.t);
    const narrowerSide = band.outerLeft < band.outerRight ? 1 : band.outerRight < band.outerLeft ? -1 : null;
    const side = narrowerSide === null ? (Number(road.id.at(-1)) % 2 === 0 ? 1 : -1) : -narrowerSide;
    // Mantén el poste dentro de la banda lateral autorizada y cerca del borde
    // de calzada; añadirlo fuera del faldón lo acercaba innecesariamente a casas.
    const lateral = side > 0 ? Math.max(0.1, band.outerLeft - 0.65) : -Math.max(0.1, band.outerRight - 0.65);
    const signX = station.x + nx * lateral;
    const signZ = station.z + nz * lateral;
    const ground = terrain.heightAt(signX, signZ) + offset;
    const signNormal = new Vector3(direction.dx, 0, direction.dz);
    const signVertex = (u: number, y: number, tint: readonly [number, number, number]): number => {
      const index = buffers.positions.length / 3;
      pushVertex(signX + nx * u, y, signZ + nz * u, signNormal, ROLE_SIGN, tint);
      return index;
    };
    const signQuad = (left: number, bottom: number, right: number, top: number, tint: readonly [number, number, number]): void => {
      const a = signVertex(left, ground + bottom, tint);
      const b = signVertex(right, ground + bottom, tint);
      const c = signVertex(right, ground + top, tint);
      const d = signVertex(left, ground + top, tint);
      quad(a, b, c, d);
      buffers.triangles += 2;
    };
    // Poste y disco en dos capas; el plano mira a lo largo del eje de la vía.
    signQuad(-0.035, 0.08, 0.035, 1.52, [1.35, 1.28, 1.08]);
    const disc = (radius: number, centerY: number, tint: readonly [number, number, number]): void => {
      const center = signVertex(0, centerY, tint);
      const count = 12;
      const ring: number[] = [];
      for (let i = 0; i < count; i++) {
        const angle = (Math.PI * 2 * i) / count;
        ring.push(signVertex(Math.cos(angle) * radius, centerY + Math.sin(angle) * radius, tint));
      }
      for (let i = 0; i < count; i++) {
        buffers.indices.push(center, ring[i]!, ring[(i + 1) % count]!);
      }
      buffers.triangles += count;
    };
    const centerY = ground + 1.88;
    disc(0.47, centerY, [4.5, 0.12, 0.08]);
    disc(0.36, centerY, [4.8, 4.8, 4.6]);
    // Dígitos de siete segmentos (metros/horas según la señal española).
    const digits = String(speedLimit).split('').map(Number);
    const segmentMap: Record<number, readonly number[]> = {
      0: [0, 1, 2, 4, 5, 6], 1: [2, 5], 2: [0, 2, 3, 4, 6], 3: [0, 2, 3, 5, 6],
      4: [1, 2, 3, 5], 5: [0, 1, 3, 5, 6], 6: [0, 1, 3, 4, 5, 6],
      7: [0, 2, 5], 8: [0, 1, 2, 3, 4, 5, 6], 9: [0, 1, 2, 3, 5, 6],
    };
    const digitWidth = digits.length > 2 ? 0.16 : 0.205;
    const digitGap = 0.035;
    const totalDigitWidth = digits.length * digitWidth + (digits.length - 1) * digitGap;
    const xStart = -totalDigitWidth / 2;
    const topY = centerY + 0.16;
    const segW = digits.length > 2 ? 0.025 : 0.035;
    const segH = 0.16;
    for (let d = 0; d < digits.length; d++) {
      const x = xStart + d * (digitWidth + digitGap);
      const midX = x + digitWidth / 2;
      const midY = centerY;
      const segments = [
        [midX, topY + segH / 2, digitWidth * 0.76, segW],
        [x + segW / 2, midY + segH / 2, segW, segH],
        [x + digitWidth - segW / 2, midY + segH / 2, segW, segH],
        [midX, midY, digitWidth * 0.76, segW],
        [x + segW / 2, midY - segH / 2, segW, segH],
        [x + digitWidth - segW / 2, midY - segH / 2, segW, segH],
        [midX, topY - segH * 1.5, digitWidth * 0.76, segW],
      ] as const;
      for (const segment of segmentMap[digits[d]!] ?? []) {
        const [u, y, w, h] = segments[segment]!;
        signQuad(u - w / 2, y - h / 2, u + w / 2, y + h / 2, [0.035, 0.035, 0.03]);
      }
    }
    buffers.signs += 1;
  }

  if (!road.bridge && useSkirt) for (const row of [0, stations.length-1]) {
    const a=baseVertex+row*verticesPerStation;
    buffers.terminals.push({road:buffers.roadCount,x:stations[row]!.x,z:stations[row]!.z,
      vertices:[a+pavementVertices,...Array.from({length:pavementVertices},(_,i)=>a+i),a+pavementVertices+1]});
  }
  buffers.roadIds.push(road.id);
  buffers.roadCount += 1;
  const roadPavementTriangles = (pavementVertices - 1) * 2;
  const trackDetailedTriangles = (TRACK_SECTION.length - 1) * 2;
  const roadMarkTriangles = 6;
  buffers.triangles += gaps * (roadPavementTriangles + (useSkirt ? 4 : 0)) +
    polishedGaps * (trackDetailedTriangles - roadPavementTriangles) +
    polishedRoadGaps * roadMarkTriangles;
}

/** Keep a bridge linear while connecting its endpoints to the built approach
 * centres. Copying raw DEM endpoints after levelling an approach creates a step. */
function connectBridgeDecks(buffers: Record<RoadClass, ClassBuffers>): void {
  const all = CLASSES.flatMap(cls => buffers[cls].profileGroups);
  const centers = new Map<typeof all[number], number>();
  for (const g of all) {
    const b = buffers[g.cls];
    const vertex = g.vertices.filter(v => b.roles[v] !== 4).sort((a, c) =>
      Math.hypot(b.positions[a * 3]! - g.x, b.positions[a * 3 + 2]! - g.z) - Math.hypot(b.positions[c * 3]! - g.x, b.positions[c * 3 + 2]! - g.z))[0];
    if (vertex !== undefined) centers.set(g, b.positions[vertex * 3 + 1]!);
  }
  for (const cls of CLASSES) {
    const b = buffers[cls], groups = b.profileGroups;
    for (let i = 0; i < groups.length; i++) {
      const start = groups[i]!;
      if (!start.vertices.some(v => b.roles[v] === ROLE_BRIDGE)) continue;
      let last = i;
      while (last + 1 < groups.length && groups[last + 1]!.road === start.road) last++;
      const end = groups[last]!;
      const support = (endpoint: typeof start): number => {
        let y = centers.get(endpoint)!;
        for (const g of all) {
          if (g === endpoint || Math.hypot(g.x - endpoint.x, g.z - endpoint.z) > .06) continue;
          if (buffers[g.cls].roles[g.vertices[0]!] === ROLE_BRIDGE) continue;
          y = Math.max(y, centers.get(g)!);
        }
        return y;
      };
      const y0 = support(start), y1 = support(end), length = end.t - start.t || 1;
      for (let j = i; j <= last; j++) {
        const g = groups[j]!, y = y0 + (y1 - y0) * (g.t - start.t) / length;
        for (const v of g.vertices) b.positions[v * 3 + 1] = y;
      }
      i = last;
    }
  }
}

/** Join actual centreline crossings at a common local deck. It affects only
 * the overlapping widths plus a cosine approach, never the source DEM/XZ. */
function reconcileJunctions(roads: readonly RoadSource[], buffers: Record<RoadClass, ClassBuffers>): void {
  const segments: { road: RoadSource; key: string; a: readonly [number, number]; b: readonly [number, number] }[] = [];
  const ordinals: Record<RoadClass, number> = { ROAD: 0, TRACK: 0, PATH: 0 };
  const groups = new Map<string, ClassBuffers['profileGroups']>();
  for (const road of roads) {
    const ordinal = ordinals[road.class]++, key = `${road.class}/${ordinal}`;
    groups.set(key, buffers[road.class].profileGroups.filter(g => g.road === ordinal));
    if (road.bridge) continue;
    for (let i = 1; i < road.points.length; i++) segments.push({ road, key, a: road.points[i - 1]!, b: road.points[i]! });
  }
  const events: { x: number; z: number; radius: number; keys: Set<string> }[] = [];
  const cells = new Map<string, number[]>(), tested = new Set<string>();
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i]!;
    for (let x = Math.floor((Math.min(s.a[0], s.b[0]) - s.road.width) / 32); x <= Math.floor((Math.max(s.a[0], s.b[0]) + s.road.width) / 32); x++) {
      for (let z = Math.floor((Math.min(s.a[1], s.b[1]) - s.road.width) / 32); z <= Math.floor((Math.max(s.a[1], s.b[1]) + s.road.width) / 32); z++) {
        const cell = `${x},${z}`, previous = cells.get(cell) ?? [];
        for (const j of previous) {
          const other = segments[j]!, pair = `${j}/${i}`;
          if (other.key === s.key || tested.has(pair)) continue;
          tested.add(pair);
          const ax = s.b[0] - s.a[0], az = s.b[1] - s.a[1], bx = other.b[0] - other.a[0], bz = other.b[1] - other.a[1];
          const det = ax * bz - az * bx;
          let px: number, pz: number;
          const cx = other.a[0] - s.a[0], cz = other.a[1] - s.a[1];
          const u = Math.abs(det) > 1e-8 ? (cx * bz - cz * bx) / det : Infinity;
          const v = Math.abs(det) > 1e-8 ? (cx * az - cz * ax) / det : Infinity;
          if (u >= -1e-6 && u <= 1.000001 && v >= -1e-6 && v <= 1.000001) {
            px = s.a[0] + u * ax; pz = s.a[1] + u * az;
          } else {
            // Footprints also meet at T-junctions and rounded/parallel OSM
            // endpoints whose centrelines do not mathematically intersect.
            const closest = (p: readonly [number, number], a: readonly [number, number], b: readonly [number, number]) => {
              const dx = b[0] - a[0], dz = b[1] - a[1], len2 = dx * dx + dz * dz;
              const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / (len2 || 1)));
              const x = a[0] + t * dx, z = a[1] + t * dz;
              return { distance: Math.hypot(x - p[0], z - p[1]), x: (x + p[0]) / 2, z: (z + p[1]) / 2 };
            };
            const near = [closest(s.a, other.a, other.b), closest(s.b, other.a, other.b), closest(other.a, s.a, s.b), closest(other.b, s.a, s.b)].sort((a, b) => a.distance - b.distance)[0]!;
            if (near.distance > (s.road.width + other.road.width) * .5) continue;
            px = near.x; pz = near.z;
          }
          const radius = Math.max(s.road.width, other.road.width) * .65;
          events.push({ x: px, z: pz, radius, keys: new Set([s.key, other.key]) });
        }
        previous.push(i); cells.set(cell, previous);
      }
    }
  }
  // Coincident multiway nodes form one deck. Targets read immutable profiles;
  // no pair can feed a height modified by an earlier pair back into the next.
  const parent = events.map((_, i) => i);
  const find = (i: number): number => { while (parent[i] !== i) { parent[i] = parent[parent[i]!]!; i = parent[i]!; } return i; };
  const extents = events.map(e => ({ minX: e.x, maxX: e.x, minZ: e.z, maxZ: e.z, radius: e.radius }));
  const eventCells = new Map<string, number[]>();
  for (let i = 0; i < events.length; i++) {
    const e = events[i]!, cx = Math.floor(e.x / 32), cz = Math.floor(e.z / 32);
    for (let x = cx - 1; x <= cx + 1; x++) for (let z = cz - 1; z <= cz + 1; z++) {
      for (const j of eventCells.get(`${x},${z}`) ?? []) {
        const p = events[j]!;
        if (Math.hypot(p.x - e.x, p.z - e.z) <= .25) {
          const a = find(i), b = find(j), ea = extents[a]!, eb = extents[b]!;
          const minX = Math.min(ea.minX, eb.minX), maxX = Math.max(ea.maxX, eb.maxX);
          const minZ = Math.min(ea.minZ, eb.minZ), maxZ = Math.max(ea.maxZ, eb.maxZ), radius = Math.max(ea.radius, eb.radius);
          // Prevent chains of nearby nodes from flattening a whole road.
          if (maxX - minX <= radius * 2 && maxZ - minZ <= radius * 2) {
            parent[a] = b; extents[b] = { minX, maxX, minZ, maxZ, radius };
          }
        }
      }
    }
    const key = `${cx},${cz}`, list = eventCells.get(key) ?? []; list.push(i); eventCells.set(key, list);
  }
  const clusters = new Map<number, typeof events>();
  events.forEach((e, i) => { const root = find(i), list = clusters.get(root) ?? []; list.push(e); clusters.set(root, list); });
  const original = Object.fromEntries(CLASSES.map(cls => [cls, buffers[cls].positions.slice()])) as Record<RoadClass, number[]>;
  const planes: { x: number; z: number; radius: number; y: number; gx: number; gz: number }[] = [];
  for (const cluster of clusters.values()) {
    const x = cluster.reduce((sum, e) => sum + e.x, 0) / cluster.length;
    const z = cluster.reduce((sum, e) => sum + e.z, 0) / cluster.length;
    const radius = Math.max(...cluster.map(e => e.radius + Math.hypot(e.x - x, e.z - z)));
    const keys = [...new Set(cluster.flatMap(e => [...e.keys]))].sort((a,b) => {
      const ga=groups.get(a)![0]!,gb=groups.get(b)![0]!;
      return CLASSES.indexOf(ga.cls)-CLASSES.indexOf(gb.cls)||gb.width-ga.width||buffers[ga.cls].roadIds[ga.road]!.localeCompare(buffers[gb.cls].roadIds[gb.road]!);
    });
    const list = groups.get(keys[0]!)!;
    const center = (g: typeof list[number]): number => {
      const p=original[g.cls];let vertex=-1,distance=Infinity;
      for(const v of g.vertices){if(buffers[g.cls].roles[v]===4)continue;const d=Math.hypot(p[v*3]!-g.x,p[v*3+2]!-g.z);if(d<distance){distance=d;vertex=v;}}
      return vertex<0?NaN:p[vertex*3+1]!;
    };
    let closest=Infinity,y=NaN,gx=0,gz=0;
    for(let i=1;i<list.length;i++){
      const a=list[i-1]!,b=list[i]!,dx=b.x-a.x,dz=b.z-a.z,len2=dx*dx+dz*dz;
      const t=Math.max(0,Math.min(1,((x-a.x)*dx+(z-a.z)*dz)/(len2||1)));
      const d=Math.hypot(x-a.x-t*dx,z-a.z-t*dz);
      if(d<closest){const ya=center(a),yb=center(b);closest=d;y=ya*(1-t)+yb*t;gx=(yb-ya)*dx/(len2||1);gz=(yb-ya)*dz/(len2||1);}
    }
    if(Number.isFinite(y))planes.push({x,z,radius,y,gx,gz});
  }
  // One continuous junction field for all ribbons. Preserve the principal
  // road's longitudinal grade instead of flattening each pair into a plateau.
  // Bridges are separate grade-separated decks and never receive this field.
  for(const cls of CLASSES)for(const g of buffers[cls].profileGroups){
    if(g.vertices.some(v=>buffers[cls].roles[v]===ROLE_BRIDGE))continue;
    const nearby=planes.map(p=>{const distance=Math.hypot(g.x-p.x,g.z-p.z),approach=12;
      const weight=distance<=p.radius?1:distance<p.radius+approach?.5*(1+Math.cos(Math.PI*(distance-p.radius)/approach)):0;
      return {p,weight};}).filter(p=>p.weight>0);
    if(!nearby.length)continue;
    const weight=nearby.reduce((sum,p)=>sum+p.weight,0),blend=Math.max(...nearby.map(p=>p.weight));
    const b=buffers[cls];
    for(const v of g.vertices){const index=v*3+1,px=b.positions[v*3]!,pz=b.positions[v*3+2]!;
      const target=nearby.reduce((sum,{p,weight})=>sum+(p.y+p.gx*(px-p.x)+p.gz*(pz-p.z))*weight,0)/weight+(b.roles[v]===4?.025:0);
      b.positions[index]=original[cls][index]!*(1-blend)+target*blend;
    }
  }

}

/** Close the exposed cut/fill face only at isolated OSM termini. Shared nodes
 * use the junction field; bridges remain grade-separated. No XZ is extended. */
function closeTerminalEarthworks(roads: readonly RoadSource[], buffers: Record<RoadClass,ClassBuffers>, terrain:RoadTerrain):void {
  const nodes=new Map<string,Set<string>>();
  for(const road of roads)for(const p of road.points){const key=`${p[0]},${p[1]}`,ids=nodes.get(key)??new Set<string>();ids.add(road.id);nodes.set(key,ids);}
  for(const cls of CLASSES){const b=buffers[cls];for(const terminal of b.terminals){
    if((nodes.get(`${terminal.x},${terminal.z}`)?.size??0)>1)continue;
    const first=b.positions.length/3;
    for(const v of terminal.vertices){const x=b.positions[v*3]!,z=b.positions[v*3+2]!,top=b.positions[v*3+1]!,bottom=terrain.heightAt(x,z);
      for(const y of [top,bottom]){b.positions.push(x,y,z);b.normals.push(0,1,0);b.colors.push(...b.colors.slice(v*4,v*4+4));b.roles.push(5);b.owners.push(terminal.road);b.tangents.push(b.tangents[v*2]!,b.tangents[v*2+1]!);}
    }
    for(let i=0;i<terminal.vertices.length-1;i++){const a=first+i*2,c=a+2;b.indices.push(a,a+1,c+1,a,c+1,c);}
  }}
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
      /** Signed relation to RAW MDT. Negative values are designed cuts; the rendered terrain is excised inside the ribbon footprint. */
      readonly surfaceClearance: {
        readonly reference: 'RAW_MDT';
        readonly samples: number;
        readonly belowTerrain: number;
        readonly minM: number;
        readonly worst: { readonly x: number; readonly y: number; readonly z: number; readonly terrainY: number } | null;
      };
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
  readonly speedSigns: number;
  readonly maxTerrainClearanceLiftM: Record<RoadClass, number>;
}

export interface RoadNetwork {
  readonly meshes: readonly Mesh[];
  readonly surface: RoadSurfaceSampler;
  gradingTriangles(): Float32Array;
  readonly stats: RoadDrapingStats;
  /** Líneas XZ de la fuente OSM ya parseada, sin solicitar roads.json otra vez. */
  mapLines(): readonly RoadMapLine[];
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
  readonly roughness: number;
  /** Sesgo de profundidad (polygon offset). Más negativo = más al frente. */
  readonly zOffset: number;
}

const MATERIALS: Record<RoadClass, MaterialSpec> = {
  ROAD: { name: 'road:asfalto', diffuse: [0.08, 0.08, 0.08], roughness: 0.9, zOffset: -3 },
  TRACK: { name: 'road:tierra', diffuse: [0.14, 0.08, 0.025], roughness: 0.96, zOffset: -2 },
  PATH: { name: 'road:senda', diffuse: [0.16, 0.13, 0.075], roughness: 0.97, zOffset: -1 },
};

function createMaterial(scene: Scene, spec: MaterialSpec): PBRMaterial {
  const material = new PBRMaterial(spec.name, scene);
  material.albedoColor = new Color3(spec.diffuse[0], spec.diffuse[1], spec.diffuse[2]);
  material.metallic = 0;
  material.reflectivityColor = new Color3(0.04, 0.04, 0.04);
  material.roughness = spec.roughness;
  material.backFaceCulling = false;
  // Polygon offset: compensa la pérdida de precisión de profundidad a distancia
  // (los offsets geométricos son menores que la resolución de depth a ~1 km).
  // El escalón por clase también define quién gana en los cruces.
  material.zOffset = spec.zOffset;
  material.freeze();
  return material;
}

function createMesh(scene: Scene, name: string, data: TypedClass, material: PBRMaterial): Mesh {
  // Width trims can collapse a side to the centreline. Faces with zero XZ
  // footprint are curtains/degenerates, never road surface.
  const valid: number[] = [];
  for (let i = 0; i < data.indices.length; i += 3) {
    const a = data.indices[i]! * 3, b = data.indices[i + 1]! * 3, c = data.indices[i + 2]! * 3;
    if ([a, b, c].some(v => (data.roles[v / 3] === ROLE_SIGN || data.roles[v / 3] === 5))) { valid.push(data.indices[i]!, data.indices[i + 1]!, data.indices[i + 2]!); continue; }
    const area = (data.positions[b]! - data.positions[a]!) * (data.positions[c + 2]! - data.positions[a + 2]!) - (data.positions[b + 2]! - data.positions[a + 2]!) * (data.positions[c]! - data.positions[a]!);
    if (Math.abs(area) > 1e-4) valid.push(data.indices[i]!, data.indices[i + 1]!, data.indices[i + 2]!);
  }
  // Compact the typed index view used by mesh, contacts and audit together.
  data.indices = new Uint32Array(valid);
  const vertexData = new VertexData();
  vertexData.positions = data.positions;
  VertexData.ComputeNormals(data.positions, data.indices, data.normals);
  // Ribbons use two-sided winding inherited from the draping mesh. Lighting
  // support faces must point upward, just like the triangle contact normal.
  for (let i = 0; i < data.normals.length; i += 3) {
    if (data.roles[i / 3] === ROLE_SIGN || data.normals[i + 1]! >= 0) continue;
    data.normals[i] = -data.normals[i]!;
    data.normals[i + 1] = -data.normals[i + 1]!;
    data.normals[i + 2] = -data.normals[i + 2]!;
  }
  vertexData.normals = data.normals;
  vertexData.colors = data.colors;
  vertexData.indices = data.indices;
  const mesh = new Mesh(name, scene);
  vertexData.applyToMesh(mesh, false);
  mesh.material = material;
  mesh.useVertexColors = true;
  // Roads receive the vehicle/actor shadows so wheels stay visually grounded as
  // the route crosses from terrain onto the draped surface.
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
  /** Zona local de rodadas y bordes de pista; omitir para mantener la cinta base. */
  /**
   * Corredor de la ruta jugable. El faldón de mezcla de la pista de tierra se dibuja
   * solo dentro de este corredor: la red tiene 137 km de pistas y cubrirlas todas
   * costaba ~162 k triángulos más en una malla que se dibuja entera cuando algo de la
   * clase TRACK entra en cámara.
   */
  readonly trackBlendCorridor?: { readonly points: readonly { readonly x: number; readonly z: number }[]; readonly radiusM: number };
  readonly polishTrackAt?: LocalPolishZone;
  /** Marcas ligeras en la carretera ancha próxima a la salida del pueblo. */
  readonly polishRoadAt?: LocalPolishZone;
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
    buildRoad(buffers[road.class], road, surface, options.polishTrackAt, options.polishRoadAt, options.trackBlendCorridor);
  }

  reconcileJunctions(roads, buffers);
  const maxTerrainClearanceLiftM: Record<RoadClass, number> = {
    ROAD: 0,
    TRACK: 0,
    PATH: 0,
  };

  connectBridgeDecks(buffers);
  closeTerminalEarthworks(roads,buffers,surface);
  const typed: Record<RoadClass, TypedClass> = {
    ROAD: toTyped(buffers.ROAD),
    TRACK: toTyped(buffers.TRACK),
    PATH: toTyped(buffers.PATH),
  };

  const materials: Record<RoadClass, PBRMaterial> = {
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
    const classTriangles = typed[cls].indices.length / 3;
    triangleCount += classTriangles;
    byClass[cls] = { roads: b.roadCount, stations: b.stations.length, vertices: classVertices, triangles: classTriangles };
  }

  const stats: RoadDrapingStats = {
    roads: roads.length,
    vertices: vertexCount,
    triangles: triangleCount,
    meshes: meshes.length,
    byClass,
    constants: DRAPING,
    bridges,
    speedSigns: buffers.ROAD.signs,
    maxTerrainClearanceLiftM,
  };

  const mapLines: readonly RoadMapLine[] = roads.map((road) => ({
    id: road.id,
    class: road.class,
    points: road.points,
    width: road.width,
    ...(road.clearance ? { clearance: road.clearance } : {}),
  }));

  const audit = (): RoadAuditReport => {
    const classes = {} as RoadAuditReport['classes'];
    for (const cls of CLASSES) {
      const positions = typed[cls].positions;
      const roles = typed[cls].roles;
      const indices = typed[cls].indices;
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
        else if (role !== ROLE_SIGN && role !== 5) pavement.push(sample);
      }
      let clearanceSamples = 0;
      let belowTerrain = 0;
      let minClearance = Infinity;
      let worstClearance: RoadAuditReport['classes'][RoadClass]['surfaceClearance']['worst'] = null;
      // Check each triangle's vertices, edge midpoints and centroid. This catches
      // terrain poking through between vertices, which a vertex-only audit misses.
      for (let i = 0; i < indices.length; i += 3) {
        const ia = indices[i]!;
        const ib = indices[i + 1]!;
        const ic = indices[i + 2]!;
        if ([roles[ia], roles[ib], roles[ic]].some((role) => role === ROLE_BRIDGE || role === ROLE_SIGN || role === 5)) continue;
        const ax = positions[ia * 3]!;
        const ay = positions[ia * 3 + 1]!;
        const az = positions[ia * 3 + 2]!;
        const bx = positions[ib * 3]!;
        const by = positions[ib * 3 + 1]!;
        const bz = positions[ib * 3 + 2]!;
        const cx = positions[ic * 3]!;
        const cy = positions[ic * 3 + 1]!;
        const cz = positions[ic * 3 + 2]!;
        for (const [wa, wb, wc] of ROAD_CLEARANCE_SAMPLES) {
          const x = wa * ax + wb * bx + wc * cx;
          const y = wa * ay + wb * by + wc * cy;
          const z = wa * az + wb * bz + wc * cz;
          const terrainY = surface.heightAt(x, z);
          const clearance = y - terrainY;
          clearanceSamples++;
          if (clearance < -1e-3) belowTerrain++;
          if (clearance < minClearance) {
            minClearance = clearance;
            worstClearance = { x, y, z, terrainY };
          }
        }
      }
      classes[cls] = {
        pavement: summarize(pavement),
        skirt: skirt.length > 0 ? summarize(skirt) : null,
        bridge: bridge.length > 0 ? summarize(bridge) : null,
        surfaceClearance: {
          reference: 'RAW_MDT',
          samples: clearanceSamples,
          belowTerrain,
          minM: Number.isFinite(minClearance) ? minClearance : 0,
          worst: worstClearance,
        },
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
    surface: createRenderedRoadSurface(surface, CLASSES.map((cls) => ({ class: cls, ...typed[cls], stations: buffers[cls].stations }))),
    stats,
    gradingTriangles: () => {
      const triangles = CLASSES.flatMap((cls) => buffers[cls].footprint);
      return new Float32Array(triangles);
    },
    mapLines: () => mapLines,
    audit,
    probe,
    stations,
    dispose: () => {
      for (const mesh of meshes) mesh.dispose();
      for (const cls of CLASSES) materials[cls].dispose();
    },
  };
}
