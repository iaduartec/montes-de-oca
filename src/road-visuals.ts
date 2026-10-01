export interface RoadProfileOptions {
  readonly radiusM: number;
  readonly maxFillM: number;
  readonly transitionM: number;
}

export interface RoadTrianglePoint {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export type RoadSurfaceClass = 'ROAD' | 'TRACK' | 'PATH';

/** Deterministic, non-periodic value noise used only for artistic vertex color. */
function hashGrid(x: number, z: number): number {
  if (x === 0 && z === 0) return 0.5;
  let value = Math.imul(x | 0, 0x1f123bb5) ^ Math.imul(z | 0, 0x5f356495);
  value = Math.imul(value ^ (value >>> 15), value | 1);
  value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
  return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
}

function smoothNoise(x: number, z: number): number {
  const x0 = Math.floor(x);
  const z0 = Math.floor(z);
  const tx = x - x0;
  const tz = z - z0;
  const fade = (t: number): number => t * t * (3 - 2 * t);
  const a = hashGrid(x0, z0) * (1 - fade(tx)) + hashGrid(x0 + 1, z0) * fade(tx);
  const b = hashGrid(x0, z0 + 1) * (1 - fade(tx)) + hashGrid(x0 + 1, z0 + 1) * fade(tx);
  return a * (1 - fade(tz)) + b * fade(tz);
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = Math.max(0, Math.min(1, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * Local damp marks are artistic vertex-color detail, not surveyed soil or wetness.
 * A sparse jittered cell field plus warped edges avoids a repeated stripe pattern.
 */
function dampPatch(x: number, z: number): number {
  const cellSize = 38;
  const cellX = Math.floor(x / cellSize);
  const cellZ = Math.floor(z / cellSize);
  let coverage = 0;
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      const gx = cellX + dx;
      const gz = cellZ + dz;
      const seed = hashGrid(gx, gz);
      if (seed > 0.38) continue;
      const centerX = (gx + 0.18 + hashGrid(gx + 17, gz - 11) * 0.64) * cellSize;
      const centerZ = (gz + 0.18 + hashGrid(gx - 7, gz + 23) * 0.64) * cellSize;
      const angle = hashGrid(gx + 31, gz + 9) * Math.PI;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const offsetX = x - centerX;
      const offsetZ = z - centerZ;
      const along = (offsetX * cos + offsetZ * sin) / (5 + hashGrid(gx + 3, gz + 41) * 5);
      const across = (-offsetX * sin + offsetZ * cos) / (2.5 + hashGrid(gx + 43, gz + 5) * 2.5);
      const edgeWarp = (smoothNoise(x * 0.11, z * 0.11) - 0.5) * 0.42;
      const radius = Math.hypot(along, across) + edgeWarp;
      const mark = 1 - smoothstep(0.72, 1.08, radius);
      coverage = Math.max(coverage, mark);
    }
  }
  return coverage;
}

/** Deterministic vertex shading; frequencies match the existing road mesh sampling. */
export function roadVertexShade(classValue: RoadSurfaceClass, x: number, z: number): number {
  const broad = Math.sin(x * 0.043 + z * 0.061) * Math.cos(z * 0.037 - x * 0.052);
  const middle = Math.sin(x * 0.19 + z * 0.31) * Math.cos(z * 0.27 - x * 0.23);
  const fine = Math.sin(x * 0.53 - z * 0.41) * Math.cos(z * 0.47 + x * 0.37);
  const n = broad * 0.45 + middle * 0.35 + fine * 0.2;
  const patch = 0.5 + 0.5 * n;
  if (classValue === 'ROAD') return 0.2 + 0.04 * patch;
  if (classValue === 'TRACK') return (0.68 + 0.42 * patch) * (1 - 0.24 * dampPatch(x, z));
  return (0.84 + 0.16 * patch) * (1 - 0.07 * dampPatch(x, z));
}

/** Warm chroma for dirt, kept subtler on narrow paths; asphalt remains neutral. */
export function roadVertexHue(classValue: RoadSurfaceClass, x: number, z: number): readonly [number, number, number] {
  if (classValue === 'ROAD') return [1, 1, 1];
  const broadGravel = smoothNoise(x * 0.075 + 9, z * 0.075 - 13) - 0.5;
  const grain = smoothNoise(x * 0.31 - 4, z * 0.31 + 7) - 0.5;
  const baseHue = Math.sin(x * 0.11 + z * 0.17) * Math.cos(z * 0.13 - x * 0.09);
  const hue = baseHue * 0.75 + broadGravel * 0.68 + grain * 0.32;
  const strength = classValue === 'TRACK' ? 0.075 : 0.02;
  return [1 + hue * strength, 1 + hue * strength * 0.25, 1 - hue * strength * 0.7];
}

/** Holgura adicional contra el DEM para impedir destellos de terreno sobre calzada. */
export const ROAD_SURFACE_CLEARANCE_M = 0.12;

/** Malla baricéntrica 4×: incluye 15 puntos repartidos por el triángulo. */
export const ROAD_CLEARANCE_SAMPLES: readonly (readonly [number, number, number])[] = (() => {
  const samples: [number, number, number][] = [];
  const divisions = 4;
  for (let a = 0; a <= divisions; a++) {
    for (let b = 0; b <= divisions - a; b++) {
      const c = divisions - a - b;
      samples.push([a / divisions, b / divisions, c / divisions]);
    }
  }
  return samples;
})();

/** Máximo alzamiento requerido para que el DEM no atraviese un triángulo vial. */
export function calculateTriangleTerrainLift(
  vertices: readonly [RoadTrianglePoint, RoadTrianglePoint, RoadTrianglePoint],
  heightAt: (x: number, z: number) => number,
  clearanceM: number,
): number {
  let needed = 0;
  for (const [wa, wb, wc] of ROAD_CLEARANCE_SAMPLES) {
    const x = wa * vertices[0].x + wb * vertices[1].x + wc * vertices[2].x;
    const y = wa * vertices[0].y + wb * vertices[1].y + wc * vertices[2].y;
    const z = wa * vertices[0].z + wb * vertices[1].z + wc * vertices[2].z;
    needed = Math.max(needed, heightAt(x, z) + clearanceM - y);
  }
  return Math.max(0, needed);
}

/** Rellena baches suaves del perfil sin bajar la calzada ni cambiar sus extremos. */
export function levelRoadProfile(
  distances: readonly number[],
  elevations: readonly number[],
  options: RoadProfileOptions,
): number[] {
  const { radiusM, maxFillM, transitionM } = options;
  if (distances.length !== elevations.length || distances.length < 2) {
    throw new Error('El perfil vial necesita distancias y cotas de igual longitud (mínimo dos estaciones)');
  }
  if (![radiusM, maxFillM, transitionM].every(Number.isFinite) || radiusM <= 0 || maxFillM < 0 || transitionM < 0) {
    throw new Error('Parámetros inválidos para nivelar el perfil vial');
  }
  for (let i = 0; i < distances.length; i++) {
    if (!Number.isFinite(distances[i]) || !Number.isFinite(elevations[i])) throw new Error('Perfil vial con valores no finitos');
    if (i > 0 && distances[i]! <= distances[i - 1]!) throw new Error('Las distancias del perfil vial deben ser estrictamente crecientes');
  }

  const smoothstep = (x: number): number => {
    const t = Math.max(0, Math.min(1, x));
    return t * t * (3 - 2 * t);
  };
  return elevations.map((raw, index) => {
    const d = distances[index]!;
    let weighted = 0;
    let totalWeight = 0;
    for (let j = 0; j < distances.length; j++) {
      const distance = Math.abs(distances[j]! - d);
      if (distance > radiusM) continue;
      const weight = 1 - distance / radiusM;
      weighted += elevations[j]! * weight;
      totalWeight += weight;
    }
    const target = totalWeight > 0 ? weighted / totalWeight : raw;
    const fromStart = d - distances[0]!;
    const toEnd = distances.at(-1)! - d;
    const fade = transitionM === 0 ? 1 : Math.min(smoothstep(fromStart / transitionM), smoothstep(toEnd / transitionM));
    return raw + Math.min(maxFillM, Math.max(0, target - raw)) * fade;
  });
}

export function parseSpeedLimitKph(value: unknown): number | null {
  if (typeof value === 'number') return Number.isInteger(value) && value >= 1 && value <= 120 ? value : null;
  if (typeof value !== 'string') return null;
  const match = value.trim().match(/^(\d{1,3})(?:\s*(?:km\/?h|kmh))?$/i);
  if (!match) return null;
  const limit = Number(match[1]);
  return limit >= 1 && limit <= 120 ? limit : null;
}

interface RoadVisualMetadata {
  readonly class: string;
  readonly width: number;
  readonly bridge: boolean;
  readonly ref?: string;
  readonly maxspeed?: unknown;
}

export function shouldMarkRoad(road: RoadVisualMetadata): boolean {
  return road.class === 'ROAD' && road.width >= 6.5 && !road.bridge;
}

export function shouldPlaceSpeedSign(road: RoadVisualMetadata, lengthM: number): boolean {
  return road.class === 'ROAD' && road.ref === 'N-120' && !road.bridge &&
    Number.isFinite(lengthM) && lengthM >= 150 && parseSpeedLimitKph(road.maxspeed) !== null;
}
