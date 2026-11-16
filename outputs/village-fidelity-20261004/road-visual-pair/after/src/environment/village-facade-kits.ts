/** Shared, deterministic facade modules for procedural rural buildings.
 *
 * These are art profiles, not material or facade facts inferred from OSM.
 */

export interface VillageFacadeKit {
  readonly id: string;
  readonly tileCourses: boolean;
  readonly stoneReturns: boolean;
  readonly chimney: boolean;
  readonly porton: boolean;
  readonly sparseWindows: boolean;
  readonly shutters: boolean;
}

export interface FacadeRoutePoint {
  readonly x: number;
  readonly z: number;
}

export type FacadeFootprint = readonly (readonly [number, number])[];

export const VILLAGE_FACADE_KITS: readonly VillageFacadeKit[] = [
  { id: 'calle-mayor', tileCourses: true, stoneReturns: true, chimney: false, porton: false, sparseWindows: false, shutters: true },
  { id: 'casa-rural', tileCourses: true, stoneReturns: false, chimney: true, porton: false, sparseWindows: true, shutters: true },
  { id: 'casa-cuadra', tileCourses: false, stoneReturns: true, chimney: true, porton: true, sparseWindows: true, shutters: false },
];

export interface VillageFacadeKitSources {
  readonly building?: VillageFacadeKit;
  readonly evidence?: VillageFacadeKit;
  readonly artistic?: VillageFacadeKit;
}

/** Evidence-backed choices take precedence; stable ID hashing remains fallback. */
export function selectVillageFacadeKit(buildingId: number, sources: VillageFacadeKitSources = {}): VillageFacadeKit {
  if (sources.building) return sources.building;
  if (sources.evidence) return sources.evidence;
  if (sources.artistic) return sources.artistic;
  let hash = buildingId | 0;
  hash = Math.imul(hash ^ (hash >>> 16), 0x45d9f3b);
  hash = Math.imul(hash ^ (hash >>> 16), 0x45d9f3b);
  hash ^= hash >>> 16;
  return VILLAGE_FACADE_KITS[(hash >>> 0) % VILLAGE_FACADE_KITS.length]!;
}

/** Return the initial route prefix ending at the nearest supplied leg endpoint. */
export function routePrefixToEndpoint<T extends FacadeRoutePoint>(
  route: readonly T[],
  endpoint: FacadeRoutePoint,
): FacadeRoutePoint[] {
  if (route.length === 0) return [];
  let endpointIndex = 0;
  let bestDistance = Infinity;
  for (let i = 0; i < route.length; i++) {
    const point = route[i]!;
    const distance = Math.hypot(point.x - endpoint.x, point.z - endpoint.z);
    if (distance < bestDistance) {
      bestDistance = distance;
      endpointIndex = i;
    }
  }
  const result = route.slice(0, endpointIndex + 1).map(({ x, z }) => ({ x, z }));
  const last = result[result.length - 1]!;
  if (Math.hypot(last.x - endpoint.x, last.z - endpoint.z) > 0.01) result.push({ x: endpoint.x, z: endpoint.z });
  return result;
}

/**
 * Find the route point nearest a building footprint. Sampling each route segment
 * at most 2 m apart keeps the frontage query stable without a per-building mesh.
 */
export function nearestFacadeRoutePoint(
  footprint: FacadeFootprint,
  route: readonly FacadeRoutePoint[],
): (FacadeRoutePoint & { readonly distanceM: number }) | null {
  if (footprint.length < 3 || route.length === 0) return null;
  let bestDistance = Infinity;
  let bestPoint: FacadeRoutePoint | null = null;
  const visit = (x: number, z: number): void => {
    const distance = distanceToFootprint(footprint, x, z);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestPoint = { x, z };
    }
  };

  if (route.length === 1) visit(route[0]!.x, route[0]!.z);
  for (let i = 1; i < route.length; i++) {
    const a = route[i - 1]!;
    const b = route[i]!;
    const length = Math.hypot(b.x - a.x, b.z - a.z);
    const steps = Math.max(1, Math.ceil(length / 2));
    for (let step = 0; step <= steps; step++) {
      const t = step / steps;
      visit(a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t);
    }
  }
  const nearest = bestPoint as FacadeRoutePoint | null;
  return nearest ? { x: nearest.x, z: nearest.z, distanceM: bestDistance } : null;
}

function distanceToFootprint(polygon: FacadeFootprint, x: number, z: number): number {
  let inside = false;
  let best = Infinity;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]!;
    const b = polygon[j]!;
    if ((a[1] > z) !== (b[1] > z) && x < ((b[0] - a[0]) * (z - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const lengthSquared = dx * dx + dz * dz;
    const t = lengthSquared > 0 ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / lengthSquared)) : 0;
    best = Math.min(best, Math.hypot(x - (a[0] + t * dx), z - (a[1] + t * dz)));
  }
  return inside ? 0 : best;
}
