export interface EaveFacade {
  readonly ax: number;
  readonly az: number;
  readonly bx: number;
  readonly bz: number;
  /** Unit normal pointing from the wall toward the outside of the building. */
  readonly nx: number;
  readonly nz: number;
}

export interface RoadClearanceSample {
  readonly x: number;
  readonly z: number;
  /** Protected road corridor radius at this centerline station. */
  readonly radiusM: number;
}

export const VILLAGE_DETAIL_RADIUS_M = 150;
// More than ROAD's 5.2 m corridor + 0.35 m roof overhang + 0.1 m visible gap.
export const VILLAGE_ROAD_CLEARANCE_QUERY_RADIUS_M = VILLAGE_DETAIL_RADIUS_M + 10;

/**
 * Limit a facade's roof overhang so sampled road corridors stay outside it.
 * Each station is treated as a disc around the road centerline; the facade's
 * possible eave is the rectangle between the wall edge and its offset edge.
 */
export function constrainEaveOverhang(
  facade: EaveFacade,
  roads: readonly RoadClearanceSample[],
  maxOverhangM: number,
  gapM = 0.1,
): number {
  const dx = facade.bx - facade.ax;
  const dz = facade.bz - facade.az;
  const length = Math.hypot(dx, dz);
  const normalLength = Math.hypot(facade.nx, facade.nz);
  if (length < 1e-6 || normalLength < 1e-6 || maxOverhangM <= 0) return 0;

  const tx = dx / length;
  const tz = dz / length;
  const nx = facade.nx / normalLength;
  const nz = facade.nz / normalLength;
  let overhang = maxOverhangM;

  for (const road of roads) {
    if (!Number.isFinite(road.x) || !Number.isFinite(road.z) || !Number.isFinite(road.radiusM) || road.radiusM < 0) {
      continue;
    }
    const rx = road.x - facade.ax;
    const rz = road.z - facade.az;
    const along = rx * tx + rz * tz;
    const outside = rx * nx + rz * nz;
    const tangentGap = along < 0 ? -along : along > length ? along - length : 0;
    const protectedRadius = road.radiusM + Math.max(0, gapM);
    if (tangentGap >= protectedRadius) continue;

    const normalReach = Math.sqrt(protectedRadius * protectedRadius - tangentGap * tangentGap);
    const available = outside - normalReach;
    if (available <= 0) return 0;
    overhang = Math.min(overhang, available);
  }

  return Math.max(0, overhang);
}
