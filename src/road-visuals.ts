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
