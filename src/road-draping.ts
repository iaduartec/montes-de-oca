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
 *     línea central, limitado para que nunca quede bajo el terreno. Muestreo
 *     longitudinal y transversal fino evita que la malla corte el DEM entre
 *     vértices; los faldones cosen el asfalto a la ladera.
 *  3. Offset vertical de la cinta: 0,10 m (evita z-fighting sin leerse como
 *     "flotando").
 *  4. Subdivisión a 2,5 m y secciones transversales de hasta 1,5 m. Vértices OSM preservados.
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
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import type { Scene } from '@babylonjs/core/scene';
import {
  calculateTriangleTerrainLift,
  levelRoadProfile,
  parseSpeedLimitKph,
  ROAD_CLEARANCE_SAMPLES,
  ROAD_SURFACE_CLEARANCE_M,
  shouldMarkRoad,
  shouldPlaceSpeedSign,
} from './road-visuals';

/** Clases viales del entregable de la FASE 3a. */
export type RoadClass = 'ROAD' | 'TRACK' | 'PATH';

export interface RoadMapLine {
  readonly id: string;
  readonly class: RoadClass;
  readonly points: readonly (readonly [number, number])[];
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
   * Cota del borde libre de los faldones (m). Queda por debajo del offset de
   * cualquier calzada para que en cruces el z-buffer resuelva a favor del asfalto.
   */
  skirtLiftM: 0.04,
} as const;
const SURFACE_CLEARANCE_M = DRAPING.surfaceClearanceM;
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
  readonly stations: { x: number; z: number; dx: number; dz: number }[];
  roadCount: number;
  triangles: number;
  signs: number;
}

function emptyBuffers(): ClassBuffers {
  return { positions: [], normals: [], colors: [], indices: [], roles: [], stations: [], roadCount: 0, triangles: 0, signs: 0 };
}

interface TypedClass {
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly colors: Float32Array;
  readonly indices: Uint32Array;
  readonly roles: Uint8Array;
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
  };
}

/** Mottling determinista de baja/media frecuencia; se calcula al construir la malla. */
function vertexShade(classValue: RoadClass, x: number, z: number): number {
  const broad = Math.sin(x * 0.043 + z * 0.061) * Math.cos(z * 0.037 - x * 0.052);
  const middle = Math.sin(x * 0.19 + z * 0.31) * Math.cos(z * 0.27 - x * 0.23);
  const fine = Math.sin(x * 0.53 - z * 0.41) * Math.cos(z * 0.47 + x * 0.37);
  const n = broad * 0.45 + middle * 0.35 + fine * 0.2;
  const patch = 0.5 + 0.5 * n;
  if (classValue === 'ROAD') return 0.2 + 0.04 * patch;
  if (classValue === 'TRACK') return 0.74 + 0.32 * patch;
  return 0.8 + 0.22 * patch;
}

/** Variación cromática cálida para tierra y polvo, acotada para preservar el PBR. */
function vertexHue(classValue: RoadClass, x: number, z: number): readonly [number, number, number] {
  if (classValue === 'ROAD') return [1, 1, 1];
  const hue = Math.sin(x * 0.11 + z * 0.17) * Math.cos(z * 0.13 - x * 0.09);
  const strength = classValue === 'TRACK' ? 0.055 : 0.035;
  return [1 + hue * strength, 1 + hue * strength * 0.25, 1 - hue * strength * 0.7];
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
  blendCorridor?: LoadRoadNetworkOptions['trackBlendCorridor'],
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
  const cercaDeRuta =
    isTrackClass && blendCorridor !== undefined && blendCorridor.points.length > 0
      ? stations.some(
          (station, index) =>
            index % 4 === 0 &&
            blendCorridor.points.some(
              (point) => Math.hypot(station.x - point.x, station.z - point.z) <= blendCorridor.radiusM,
            ),
        )
      : false;
  const useSkirt = (isRoadClass || (isTrackClass && !detallePista && cercaDeRuta)) && !road.bridge;
  const smoothProfile = isRoadClass && !road.bridge
    ? levelRoadProfile(
      stations.map((station) => station.t),
      stations.map((station) => terrain.heightAt(station.x, station.z)),
      { radiusM: 20, maxFillM: 0.6, transitionM: 18 },
    )
    : null;

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
    buffers.positions.push(x, y, z);
    buffers.normals.push(normal.x, normal.y, normal.z);
    const shade = vertexShade(road.class, x, z);
    const hue = vertexHue(road.class, x, z);
    buffers.colors.push(
      shade * hue[0] * (tint?.[0] ?? 1),
      shade * hue[1] * (tint?.[1] ?? 1),
      shade * hue[2] * (tint?.[2] ?? 1),
      1,
    );
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

    const centerY = smoothProfile?.[i] ?? terrain.heightAt(station.x, station.z);
    const bridgeT = station.t / totalLength;

    // Altura de calzada en un punto lateral. ROAD no-puente: aplanado parcial.
    const pavementY = (px: number, pz: number): number => {
      if (road.bridge) return startY + (endY - startY) * bridgeT + offset;
      const terrainY = terrain.heightAt(px, pz);
      if (isRoadClass) {
        const flattenedY = terrainY + DRAPING.roadFlattenLerp * (centerY - terrainY);
        // A lateral bank can be higher than the centreline. Never bury the
        // asphalt below that bank; the extra cross-sections let the shoulder
        // meet this protected surface without green terrain cutting through.
        return Math.max(terrainY, flattenedY) + offset;
      }
      return terrainY + offset;
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
      pushVertex(x, terrain.heightAt(x, z) + offset, z, terrain.normalAt(x, z, scratch), ROLE_PAVEMENT, tint);
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
      const station = stations[stationIndex]!;
      const direction = buffers.stations[buffers.stations.length - stations.length + stationIndex]!;
      const nx = -direction.dz;
      const nz = direction.dx;
      const band = bandAt(station.t);
      const centerY = smoothProfile?.[stationIndex] ?? terrain.heightAt(station.x, station.z);
      for (const fraction of [from, to]) {
        const sideHalf = fraction < 0 ? band.pavementRight : band.pavementLeft;
        const x = station.x + nx * fraction * sideHalf;
        const z = station.z + nz * fraction * sideHalf;
        const groundY = terrain.heightAt(x, z);
        const flattenedY = groundY + DRAPING.roadFlattenLerp * (centerY - groundY);
        const y = Math.max(groundY, flattenedY) + offset + 0.025;
        const tint: readonly [number, number, number] = [
          1 + (color[0] - 1) * strength,
          1 + (color[1] - 1) * strength,
          1 + (color[2] - 1) * strength,
        ];
        pushVertex(x, y, z, terrain.normalAt(x, z, scratch), ROLE_PAVEMENT, tint);
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

  buffers.roadCount += 1;
  const roadPavementTriangles = (pavementVertices - 1) * 2;
  const trackDetailedTriangles = (TRACK_SECTION.length - 1) * 2;
  const roadMarkTriangles = 6;
  buffers.triangles += gaps * (roadPavementTriangles + (useSkirt ? 4 : 0)) +
    polishedGaps * (trackDetailedTriangles - roadPavementTriangles) +
    polishedRoadGaps * roadMarkTriangles;
}

/** Eleva vértices locales si un triángulo de la cinta atraviesa la malla DEM. */
function clearTrianglesFromTerrain(buffers: ClassBuffers, terrain: RoadTerrain): number {
  const vertexCount = buffers.positions.length / 3;
  const lifts = new Float32Array(vertexCount);
  for (let i = 0; i < buffers.indices.length; i += 3) {
    const ia = buffers.indices[i]!;
    const ib = buffers.indices[i + 1]!;
    const ic = buffers.indices[i + 2]!;
    const roles = [buffers.roles[ia], buffers.roles[ib], buffers.roles[ic]];
    if (roles.some((role) => role === ROLE_BRIDGE || role === ROLE_SIGN)) continue;
    const ax = buffers.positions[ia * 3]!;
    const ay = buffers.positions[ia * 3 + 1]!;
    const az = buffers.positions[ia * 3 + 2]!;
    const bx = buffers.positions[ib * 3]!;
    const by = buffers.positions[ib * 3 + 1]!;
    const bz = buffers.positions[ib * 3 + 2]!;
    const cx = buffers.positions[ic * 3]!;
    const cy = buffers.positions[ic * 3 + 1]!;
    const cz = buffers.positions[ic * 3 + 2]!;
    const needed = calculateTriangleTerrainLift(
      [{ x: ax, y: ay, z: az }, { x: bx, y: by, z: bz }, { x: cx, y: cy, z: cz }],
      (x, z) => terrain.heightAt(x, z),
      // El faldón es banda de mezcla: se conforma con vivir a SKIRT_LIFT_M del suelo.
      // Con el margen de calzada quedaba a la misma cota que el asfalto de una vía que
      // lo cruza y el z-buffer elegía entre ambos por píxel (franjas de tierra).
      roles.includes(ROLE_SKIRT) ? SKIRT_LIFT_M : SURFACE_CLEARANCE_M,
    );
    if (needed > 0) {
      lifts[ia] = Math.max(lifts[ia]!, needed);
      lifts[ib] = Math.max(lifts[ib]!, needed);
      lifts[ic] = Math.max(lifts[ic]!, needed);
    }
  }
  let maxLift = 0;
  for (let vertex = 0; vertex < vertexCount; vertex++) {
    const lift = lifts[vertex]!;
    if (lift <= 0) continue;
    buffers.positions[vertex * 3 + 1]! += lift;
    maxLift = Math.max(maxLift, lift);
  }
  return maxLift;
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
      /** Separación firmada con el terreno en vértices, centros y aristas de triángulo. */
      readonly surfaceClearance: {
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
  const vertexData = new VertexData();
  vertexData.positions = data.positions;
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

  const maxTerrainClearanceLiftM: Record<RoadClass, number> = {
    ROAD: clearTrianglesFromTerrain(buffers.ROAD, surface),
    TRACK: clearTrianglesFromTerrain(buffers.TRACK, surface),
    PATH: clearTrianglesFromTerrain(buffers.PATH, surface),
  };

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
    speedSigns: buffers.ROAD.signs,
    maxTerrainClearanceLiftM,
  };

  const mapLines: readonly RoadMapLine[] = roads.map((road) => ({
    id: road.id,
    class: road.class,
    points: road.points,
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
        else if (role !== ROLE_SIGN) pavement.push(sample);
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
        if ([roles[ia], roles[ib], roles[ic]].some((role) => role === ROLE_BRIDGE || role === ROLE_SIGN)) continue;
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
    stats,
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
