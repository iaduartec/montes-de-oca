import { VILLAGE_NPC_SPAWNS } from './village-npc-data';

export interface VillageNpcWalkPoint {
  readonly x: number;
  readonly z: number;
}

export interface VillageNpcRoadLine {
  readonly id: string;
  readonly class: 'ROAD' | 'TRACK' | 'PATH';
  readonly width: number;
  readonly points: readonly (readonly [number, number])[];
}

export interface VillageNpcBuildingFootprint {
  readonly footprint: readonly (readonly [number, number])[];
}

export interface VillageNpcWallLine {
  readonly points: readonly (readonly [number, number])[];
  readonly widthM: number;
}

export interface VillageNpcWalkRoute {
  readonly id: string;
  readonly roadId: string;
  readonly points: readonly [VillageNpcWalkPoint, VillageNpcWalkPoint];
  readonly lengthM: number;
}

export interface VillageNpcNavigationSources {
  readonly roads: readonly VillageNpcRoadLine[];
  readonly buildings: readonly VillageNpcBuildingFootprint[];
  readonly walls: readonly VillageNpcWallLine[];
  readonly waterDepthAt: (x: number, z: number) => number;
  readonly heightAt: (x: number, z: number) => number;
  readonly normalAt: (x: number, z: number) => { readonly x: number; readonly y: number; readonly z: number };
}

export interface VillageNpcRouteGeneration {
  readonly routes: readonly VillageNpcWalkRoute[];
  readonly candidateCount: number;
  readonly sampleStepM: number;
  readonly rejected: Readonly<Record<'road' | 'building' | 'wall' | 'water' | 'terrain' | 'anchor' | 'spacing', number>>;
}

const WALKING_NPC_COUNT = 8;
const SEARCH_RADIUS_M = 100;
const ROUTE_HALF_LENGTH_M = 2;
const SOURCE_STATION_STEP_M = 4;
const ROUTE_VALIDATION_STEP_M = 0.25;
const NPC_BODY_RADIUS_M = 0.28;
const ROAD_EDGE_CLEARANCE_M = 0.55;
const BUILDING_CLEARANCE_M = 0.65;
const WALL_EDGE_CLEARANCE_M = 0.55;
const TERRAIN_NORMAL_Y_MIN = Math.cos((28 * Math.PI) / 180);
const WATER_DEPTH_MAX_M = 0.01;
const NPC_SEPARATION_M = 1.4;

type RejectionReason = keyof VillageNpcRouteGeneration['rejected'];
interface RouteCandidate extends VillageNpcWalkRoute {
  readonly samples: readonly VillageNpcWalkPoint[];
  readonly sortKey: string;
}
interface RoadSegment {
  readonly road: VillageNpcRoadLine;
  readonly index: number;
  readonly a: VillageNpcWalkPoint;
  readonly b: VillageNpcWalkPoint;
  readonly lengthM: number;
}

function distance(a: VillageNpcWalkPoint, b: VillageNpcWalkPoint): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

function pointSegmentDistance(point: VillageNpcWalkPoint, a: VillageNpcWalkPoint, b: VillageNpcWalkPoint): number {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const lengthSquared = dx * dx + dz * dz;
  const t = lengthSquared > 0
    ? Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.z - a.z) * dz) / lengthSquared))
    : 0;
  return Math.hypot(point.x - a.x - dx * t, point.z - a.z - dz * t);
}

function pointInPolygon(point: VillageNpcWalkPoint, polygon: readonly (readonly [number, number])[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, zi] = polygon[i]!;
    const [xj, zj] = polygon[j]!;
    if ((zi > point.z) !== (zj > point.z) && point.x < ((xj - xi) * (point.z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

function pointPolygonClearance(point: VillageNpcWalkPoint, polygon: readonly (readonly [number, number])[]): number {
  if (pointInPolygon(point, polygon)) return 0;
  let nearest = Infinity;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i]!;
    const b = polygon[(i + 1) % polygon.length]!;
    nearest = Math.min(nearest, pointSegmentDistance(point, { x: a[0], z: a[1] }, { x: b[0], z: b[1] }));
  }
  return nearest;
}

function sampleRoute(points: readonly [VillageNpcWalkPoint, VillageNpcWalkPoint]): VillageNpcWalkPoint[] {
  const [start, end] = points;
  const length = distance(start, end);
  const steps = Math.max(1, Math.ceil(length / ROUTE_VALIDATION_STEP_M));
  return Array.from({ length: steps + 1 }, (_, index) => {
    const t = index / steps;
    return { x: start.x + (end.x - start.x) * t, z: start.z + (end.z - start.z) * t };
  });
}

function closestRoadDistance(point: VillageNpcWalkPoint, segments: readonly RoadSegment[], sourcePathId: string | null): number {
  let clearance = Infinity;
  let onSourcePath = false;
  for (const segment of segments) {
    const centerDistance = pointSegmentDistance(point, segment.a, segment.b);
    if (sourcePathId !== null && segment.road.id === sourcePathId && segment.road.class === 'PATH') {
      if (centerDistance <= segment.road.width / 2 - NPC_BODY_RADIUS_M) onSourcePath = true;
      continue;
    }
    clearance = Math.min(clearance, centerDistance - segment.road.width / 2);
  }
  if (sourcePathId !== null && !onSourcePath) return -1;
  return clearance;
}

function validateSamples(
  samples: readonly VillageNpcWalkPoint[],
  sourcePathId: string | null,
  segments: readonly RoadSegment[],
  buildings: readonly VillageNpcBuildingFootprint[],
  walls: readonly VillageNpcWallLine[],
  sources: VillageNpcNavigationSources,
): RejectionReason | null {
  for (const point of samples) {
    if (closestRoadDistance(point, segments, sourcePathId) < ROAD_EDGE_CLEARANCE_M) return 'road';
    if (buildings.some((building) => pointPolygonClearance(point, building.footprint) < BUILDING_CLEARANCE_M)) return 'building';
    for (const wall of walls) {
      for (let i = 0; i < wall.points.length - 1; i++) {
        const a = wall.points[i]!;
        const b = wall.points[i + 1]!;
        if (pointSegmentDistance(point, { x: a[0], z: a[1] }, { x: b[0], z: b[1] }) - wall.widthM / 2 < WALL_EDGE_CLEARANCE_M) return 'wall';
      }
    }
    const depth = sources.waterDepthAt(point.x, point.z);
    if (!Number.isFinite(depth) || depth > WATER_DEPTH_MAX_M) return 'water';
    const height = sources.heightAt(point.x, point.z);
    const normal = sources.normalAt(point.x, point.z);
    if (!Number.isFinite(height) || !Number.isFinite(normal.x) || !Number.isFinite(normal.y) || !Number.isFinite(normal.z) || normal.y < TERRAIN_NORMAL_Y_MIN) return 'terrain';
  }
  return null;
}

function minRouteSeparation(a: readonly VillageNpcWalkPoint[], b: readonly VillageNpcWalkPoint[]): number {
  let minimum = Infinity;
  for (const pointA of a) {
    for (const pointB of b) minimum = Math.min(minimum, distance(pointA, pointB));
  }
  return minimum;
}

function collectRoadSegments(roads: readonly VillageNpcRoadLine[], anchor: VillageNpcWalkPoint): RoadSegment[] {
  const segments: RoadSegment[] = [];
  for (const road of roads) {
    if ((road.class !== 'ROAD' && road.class !== 'PATH') || !Number.isFinite(road.width) || road.width <= 0) continue;
    for (let index = 0; index < road.points.length - 1; index++) {
      const [ax, az] = road.points[index]!;
      const [bx, bz] = road.points[index + 1]!;
      const a = { x: ax, z: az };
      const b = { x: bx, z: bz };
      const lengthM = distance(a, b);
      if (lengthM < ROUTE_HALF_LENGTH_M * 2 || pointSegmentDistance(anchor, a, b) > SEARCH_RADIUS_M + lengthM / 2) continue;
      segments.push({ road, index, a, b, lengthM });
    }
  }
  return segments.sort((a, b) => a.road.id.localeCompare(b.road.id) || a.index - b.index);
}

function candidateRoutes(segments: readonly RoadSegment[]): RouteCandidate[] {
  const candidates: RouteCandidate[] = [];
  for (const segment of segments) {
    const ux = (segment.b.x - segment.a.x) / segment.lengthM;
    const uz = (segment.b.z - segment.a.z) / segment.lengthM;
    const nx = -uz;
    const nz = ux;
    const offset = segment.road.class === 'PATH' ? 0 : segment.road.width / 2 + 0.9;
    const sides = segment.road.class === 'PATH' ? [0] : [-1, 1];
    for (let station = ROUTE_HALF_LENGTH_M; station <= segment.lengthM - ROUTE_HALF_LENGTH_M; station += SOURCE_STATION_STEP_M) {
      const centerX = segment.a.x + ux * station;
      const centerZ = segment.a.z + uz * station;
      for (const side of sides) {
        const cx = centerX + nx * offset * side;
        const cz = centerZ + nz * offset * side;
        const points: [VillageNpcWalkPoint, VillageNpcWalkPoint] = [
          { x: cx - ux * ROUTE_HALF_LENGTH_M, z: cz - uz * ROUTE_HALF_LENGTH_M },
          { x: cx + ux * ROUTE_HALF_LENGTH_M, z: cz + uz * ROUTE_HALF_LENGTH_M },
        ];
        const id = `${segment.road.id}:${segment.index}:${station.toFixed(1)}:${side}`;
        candidates.push({
          id,
          sortKey: id,
          roadId: segment.road.id,
          points,
          lengthM: distance(points[0], points[1]),
          samples: sampleRoute(points),
        });
      }
    }
  }
  return candidates;
}

/** Generate short game-authored local patrols from real road axes and validate every 25 cm sample. */
export function generateVillageNpcWalkRoutes(sources: VillageNpcNavigationSources): VillageNpcRouteGeneration {
  if (sources.roads.length === 0 || sources.buildings.length === 0 || sources.walls.length === 0) {
    throw new Error('NPC navigation: roads, building footprints and mapped walls must all be present');
  }
  for (const building of sources.buildings) {
    if (!Array.isArray(building.footprint) || building.footprint.length < 3 || building.footprint.some((point) => !Number.isFinite(point[0]) || !Number.isFinite(point[1]))) {
      throw new Error('NPC navigation: invalid building footprint data');
    }
  }
  for (const wall of sources.walls) {
    if (!Array.isArray(wall.points) || wall.points.length < 2 || !Number.isFinite(wall.widthM) || wall.widthM <= 0 || wall.points.some((point) => !Number.isFinite(point[0]) || !Number.isFinite(point[1]))) {
      throw new Error('NPC navigation: invalid mapped wall points or widthM');
    }
  }
  for (const road of sources.roads) {
    if (!Array.isArray(road.points) || road.points.length < 2 || !Number.isFinite(road.width) || road.width <= 0 || road.points.some((point) => !Number.isFinite(point[0]) || !Number.isFinite(point[1]))) {
      throw new Error(`NPC navigation: invalid road geometry (${road.id})`);
    }
  }
  const anchor = {
    x: VILLAGE_NPC_SPAWNS.reduce((sum, npc) => sum + npc.x, 0) / VILLAGE_NPC_SPAWNS.length,
    z: VILLAGE_NPC_SPAWNS.reduce((sum, npc) => sum + npc.z, 0) / VILLAGE_NPC_SPAWNS.length,
  };
  const segments = collectRoadSegments(sources.roads, anchor);
  const footprints = sources.buildings.filter((building) => building.footprint.length >= 3);
  const valid: RouteCandidate[] = [];
  const rejected: Record<RejectionReason, number> = { road: 0, building: 0, wall: 0, water: 0, terrain: 0, anchor: 0, spacing: 0 };
  for (const candidate of candidateRoutes(segments)) {
    const samples = candidate.samples;
    const midpoint = { x: (candidate.points[0].x + candidate.points[1].x) / 2, z: (candidate.points[0].z + candidate.points[1].z) / 2 };
    if (distance(midpoint, anchor) > SEARCH_RADIUS_M) {
      rejected.anchor += 1;
      continue;
    }
    const source = segments.find((segment) => segment.road.id === candidate.roadId)!;
    const reason = validateSamples(
      samples,
      source.road.class === 'PATH' ? candidate.roadId : null,
      segments,
      footprints,
      sources.walls,
      sources,
    );
    if (reason) {
      rejected[reason] += 1;
      continue;
    }
    if (VILLAGE_NPC_SPAWNS.some((npc) => minRouteSeparation(samples, [{ x: npc.x, z: npc.z }]) < NPC_SEPARATION_M)) {
      rejected.spacing += 1;
      continue;
    }
    valid.push(candidate);
  }

  const selected: RouteCandidate[] = [];
  while (selected.length < WALKING_NPC_COUNT) {
    let best: RouteCandidate | null = null;
    let bestDistance = -Infinity;
    for (const candidate of valid) {
      if (selected.includes(candidate)) continue;
      const nearest = selected.length === 0
        ? Math.min(...candidate.samples.map((point) => Math.min(...VILLAGE_NPC_SPAWNS.map((npc) => distance(point, { x: npc.x, z: npc.z })))))
        : Math.min(...selected.map((chosen) => minRouteSeparation(candidate.samples, chosen.samples)));
      if (nearest < NPC_SEPARATION_M) {
        rejected.spacing += 1;
        continue;
      }
      if (nearest > bestDistance || (nearest === bestDistance && candidate.sortKey < (best?.sortKey ?? '\uffff'))) {
        best = candidate;
        bestDistance = nearest;
      }
    }
    if (!best) break;
    selected.push(best);
  }

  if (selected.length !== WALKING_NPC_COUNT) {
    throw new Error(`NPC navigation: ${selected.length}/${WALKING_NPC_COUNT} clear walk routes; ${valid.length} candidates passed static and terrain checks`);
  }
  return {
    routes: selected.map(({ samples: _samples, sortKey: _sortKey, ...route }, index) => ({
      ...route,
      id: `vecino-${String(index + 3).padStart(2, '0')}`,
    })),
    candidateCount: valid.length,
    sampleStepM: ROUTE_VALIDATION_STEP_M,
    rejected,
  };
}
