export interface AmbientAudioLevels {
  readonly wind: number;
  readonly forest: number;
  readonly village: number;
  readonly water: number;
  /** Water direction across listener's right axis: -1 left, +1 right. */
  readonly waterPan: number;
}

export interface AmbientAudioListener {
  readonly x: number;
  readonly z: number;
  /** Radians from world north (+Z), positive clockwise toward east (+X). */
  readonly yaw: number;
}

/** Raw checked-in datasets passed once after bootstrap fetch and JSON parsing. */
export interface AmbientAudioSources {
  readonly water?: unknown | null;
  readonly vegetation?: unknown | null;
  readonly village?: unknown | null;
}

export interface AmbientAudioResolverStats {
  readonly updates: number;
  readonly waterSegments: number;
  readonly treeInstances: number;
  readonly villageFootprints: number;
  readonly lastWaterCandidates: number;
  readonly lastTreeCandidates: number;
  readonly lastVillageCandidates: number;
  readonly maxWaterCandidates: number;
  readonly maxTreeCandidates: number;
  readonly maxVillageCandidates: number;
}

export interface AmbientAudioResolver {
  /** Returns ambience levels for this pose. Input datasets were indexed once in the factory. */
  sample(listener: AmbientAudioListener): AmbientAudioLevels;
  /** Candidate counts expose the bounded local lookup cost without scanning source arrays per update. */
  stats(): AmbientAudioResolverStats;
}

const WATER_CELL_M = 50;
const TREE_CELL_M = 50;
const BUILDING_CELL_M = 50;
const WATER_FULL_M = 80;
const WATER_ZERO_M = 200;
const VILLAGE_FULL_M = 80;
const VILLAGE_ZERO_M = 200;
const TREE_RADIUS_M = 100;
const TREES_FOR_FULL_FOREST = 38;
const TREE_TYPES = new Set(['roble', 'haya', 'abedul', 'pino']);

type XZ = readonly [x: number, z: number];
interface Segment { readonly ax: number; readonly az: number; readonly bx: number; readonly bz: number; }
interface TreePoint { readonly x: number; readonly z: number; }
interface Footprint { readonly points: readonly XZ[]; readonly minX: number; readonly maxX: number; readonly minZ: number; readonly maxZ: number; }
type SpatialHash = Map<string, number[]>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function addToHash(hash: SpatialHash, id: number, minX: number, maxX: number, minZ: number, maxZ: number, size: number): void {
  const x0 = Math.floor(minX / size);
  const x1 = Math.floor(maxX / size);
  const z0 = Math.floor(minZ / size);
  const z1 = Math.floor(maxZ / size);
  for (let z = z0; z <= z1; z++) {
    for (let x = x0; x <= x1; x++) {
      const key = `${x}:${z}`;
      const bucket = hash.get(key);
      if (bucket) bucket.push(id);
      else hash.set(key, [id]);
    }
  }
}

function makeHash(items: readonly { readonly minX: number; readonly maxX: number; readonly minZ: number; readonly maxZ: number }[], size: number): SpatialHash {
  const hash: SpatialHash = new Map();
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    addToHash(hash, i, item.minX, item.maxX, item.minZ, item.maxZ, size);
  }
  return hash;
}

function forNearby(
  hash: SpatialHash,
  stamps: Uint32Array,
  stamp: number,
  x: number,
  z: number,
  radius: number,
  cellSize: number,
  visit: (index: number) => void,
): number {
  const x0 = Math.floor((x - radius) / cellSize);
  const x1 = Math.floor((x + radius) / cellSize);
  const z0 = Math.floor((z - radius) / cellSize);
  const z1 = Math.floor((z + radius) / cellSize);
  let visited = 0;
  for (let cz = z0; cz <= z1; cz++) {
    for (let cx = x0; cx <= x1; cx++) {
      const bucket = hash.get(`${cx}:${cz}`);
      if (!bucket) continue;
      for (const index of bucket) {
        if (stamps[index] === stamp) continue;
        stamps[index] = stamp;
        visited++;
        visit(index);
      }
    }
  }
  return visited;
}

function parseWaterSegments(raw: unknown): Segment[] {
  if (!isRecord(raw) || raw.schemaVersion !== 1 || !Array.isArray(raw.ribbons)) {
    throw new Error('ambient audio: water data must have schemaVersion 1 and a ribbons array');
  }
  const segments: Segment[] = [];
  for (let ribbonIndex = 0; ribbonIndex < raw.ribbons.length; ribbonIndex++) {
    const ribbon = raw.ribbons[ribbonIndex];
    if (!isRecord(ribbon) || !Array.isArray(ribbon.points) || ribbon.points.length < 2) {
      throw new Error(`ambient audio: invalid water ribbon ${ribbonIndex}`);
    }
    let previous: XZ | null = null;
    for (let pointIndex = 0; pointIndex < ribbon.points.length; pointIndex++) {
      const point = ribbon.points[pointIndex];
      if (!Array.isArray(point) || point.length < 3 || !finite(point[0]) || !finite(point[1]) || !finite(point[2])) {
        throw new Error(`ambient audio: invalid water point ${ribbonIndex}:${pointIndex}`);
      }
      const current: XZ = [point[0], point[1]];
      if (previous) {
        if (Math.hypot(current[0] - previous[0], current[1] - previous[1]) > 1e-6) {
          segments.push({ ax: previous[0], az: previous[1], bx: current[0], bz: current[1] });
        }
      }
      previous = current;
    }
  }
  return segments;
}

function parseTrees(raw: unknown): TreePoint[] {
  if (!isRecord(raw) || !isRecord(raw.meta) || raw.meta.schemaVersion !== 1 || !Array.isArray(raw.instances)) {
    throw new Error('ambient audio: vegetation data must have meta.schemaVersion 1 and an instances array');
  }
  const trees: TreePoint[] = [];
  for (let i = 0; i < raw.instances.length; i++) {
    const item = raw.instances[i];
    if (!isRecord(item) || typeof item.type !== 'string' || !finite(item.x) || !finite(item.z)) {
      throw new Error(`ambient audio: invalid vegetation instance ${i}`);
    }
    if (TREE_TYPES.has(item.type)) trees.push({ x: item.x, z: item.z });
  }
  return trees;
}

function parseFootprints(raw: unknown): Footprint[] {
  if (!isRecord(raw) || !isRecord(raw.meta) || raw.meta.schemaVersion !== 1 || !Array.isArray(raw.buildings)) {
    throw new Error('ambient audio: village data must have meta.schemaVersion 1 and a buildings array');
  }
  const footprints: Footprint[] = [];
  for (let buildingIndex = 0; buildingIndex < raw.buildings.length; buildingIndex++) {
    const building = raw.buildings[buildingIndex];
    if (!isRecord(building) || !Array.isArray(building.footprint) || building.footprint.length < 3) {
      throw new Error(`ambient audio: invalid building footprint ${buildingIndex}`);
    }
    const points: XZ[] = [];
    for (let pointIndex = 0; pointIndex < building.footprint.length; pointIndex++) {
      const point = building.footprint[pointIndex];
      if (!Array.isArray(point) || point.length < 2 || !finite(point[0]) || !finite(point[1])) {
        throw new Error(`ambient audio: invalid building point ${buildingIndex}:${pointIndex}`);
      }
      points.push([point[0], point[1]]);
    }
    footprints.push({
      points,
      minX: Math.min(...points.map((point) => point[0])),
      maxX: Math.max(...points.map((point) => point[0])),
      minZ: Math.min(...points.map((point) => point[1])),
      maxZ: Math.max(...points.map((point) => point[1])),
    });
  }
  return footprints;
}

function segmentDistanceAndPoint(x: number, z: number, segment: Segment): { readonly distance: number; readonly x: number; readonly z: number } {
  const dx = segment.bx - segment.ax;
  const dz = segment.bz - segment.az;
  const lengthSquared = dx * dx + dz * dz;
  const t = lengthSquared > 0
    ? Math.max(0, Math.min(1, ((x - segment.ax) * dx + (z - segment.az) * dz) / lengthSquared))
    : 0;
  const nearestX = segment.ax + dx * t;
  const nearestZ = segment.az + dz * t;
  return { distance: Math.hypot(x - nearestX, z - nearestZ), x: nearestX, z: nearestZ };
}

function pointSegmentDistanceSquared(x: number, z: number, a: XZ, b: XZ): number {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const lengthSquared = dx * dx + dz * dz;
  const t = lengthSquared > 0 ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / lengthSquared)) : 0;
  const ex = x - (a[0] + dx * t);
  const ez = z - (a[1] + dz * t);
  return ex * ex + ez * ez;
}

function pointInPolygon(x: number, z: number, polygon: readonly XZ[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]!;
    const b = polygon[j]!;
    if ((a[1] > z) !== (b[1] > z) && x < ((b[0] - a[0]) * (z - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

function distanceToFootprint(x: number, z: number, footprint: Footprint): number {
  if (x >= footprint.minX && x <= footprint.maxX && z >= footprint.minZ && z <= footprint.maxZ && pointInPolygon(x, z, footprint.points)) return 0;
  let minimum = Infinity;
  for (let i = 0; i < footprint.points.length; i++) {
    minimum = Math.min(minimum, pointSegmentDistanceSquared(x, z, footprint.points[i]!, footprint.points[(i + 1) % footprint.points.length]!));
  }
  return Math.sqrt(minimum);
}

function smoothProximity(distance: number, fullDistance: number, zeroDistance: number): number {
  if (distance <= fullDistance) return 1;
  if (distance >= zeroDistance) return 0;
  const t = (distance - fullDistance) / (zeroDistance - fullDistance);
  return 1 - (t * t * (3 - 2 * t));
}

/** Build all three spatial indexes once; sampling only visits cells around the listener. */
function buildAmbientAudioResolver(
  waterSegments: Segment[],
  treePoints: TreePoint[],
  footprints: Footprint[],
): AmbientAudioResolver {
  const waterHash = makeHash(waterSegments.map((segment) => ({
    minX: Math.min(segment.ax, segment.bx), maxX: Math.max(segment.ax, segment.bx),
    minZ: Math.min(segment.az, segment.bz), maxZ: Math.max(segment.az, segment.bz),
  })), WATER_CELL_M);
  const treeHash = makeHash(treePoints.map((tree) => ({ minX: tree.x, maxX: tree.x, minZ: tree.z, maxZ: tree.z })), TREE_CELL_M);
  const footprintHash = makeHash(footprints, BUILDING_CELL_M);
  const waterStamps = new Uint32Array(waterSegments.length);
  const treeStamps = new Uint32Array(treePoints.length);
  const footprintStamps = new Uint32Array(footprints.length);
  let stamp = 0;
  let updates = 0;
  let lastWaterCandidates = 0;
  let lastTreeCandidates = 0;
  let lastVillageCandidates = 0;
  let maxWaterCandidates = 0;
  let maxTreeCandidates = 0;
  let maxVillageCandidates = 0;

  const sample = (listener: AmbientAudioListener): AmbientAudioLevels => {
    if (!finite(listener.x) || !finite(listener.z) || !finite(listener.yaw)) throw new Error('ambient audio: listener x/z/yaw must be finite');
    stamp = (stamp + 1) >>> 0;
    if (stamp === 0) {
      waterStamps.fill(0);
      treeStamps.fill(0);
      footprintStamps.fill(0);
      stamp = 1;
    }
    updates++;

    let nearestWaterDistance = Infinity;
    let nearestWaterX = listener.x;
    let nearestWaterZ = listener.z;
    lastWaterCandidates = forNearby(waterHash, waterStamps, stamp, listener.x, listener.z, WATER_ZERO_M, WATER_CELL_M, (index) => {
      const nearest = segmentDistanceAndPoint(listener.x, listener.z, waterSegments[index]!);
      if (nearest.distance < nearestWaterDistance) {
        nearestWaterDistance = nearest.distance;
        nearestWaterX = nearest.x;
        nearestWaterZ = nearest.z;
      }
    });

    let density = 0;
    lastTreeCandidates = forNearby(treeHash, treeStamps, stamp, listener.x, listener.z, TREE_RADIUS_M, TREE_CELL_M, (index) => {
      const tree = treePoints[index]!;
      const distance = Math.hypot(tree.x - listener.x, tree.z - listener.z);
      if (distance < TREE_RADIUS_M) density += 1 - distance / TREE_RADIUS_M;
    });

    let villageDistance = Infinity;
    lastVillageCandidates = forNearby(footprintHash, footprintStamps, stamp, listener.x, listener.z, VILLAGE_ZERO_M, BUILDING_CELL_M, (index) => {
      villageDistance = Math.min(villageDistance, distanceToFootprint(listener.x, listener.z, footprints[index]!));
    });

    maxWaterCandidates = Math.max(maxWaterCandidates, lastWaterCandidates);
    maxTreeCandidates = Math.max(maxTreeCandidates, lastTreeCandidates);
    maxVillageCandidates = Math.max(maxVillageCandidates, lastVillageCandidates);

    const forest = Math.max(0, Math.min(1, density / TREES_FOR_FULL_FOREST));
    const water = smoothProximity(nearestWaterDistance, WATER_FULL_M, WATER_ZERO_M);
    const village = smoothProximity(villageDistance, VILLAGE_FULL_M, VILLAGE_ZERO_M);
    const toWaterX = nearestWaterX - listener.x;
    const toWaterZ = nearestWaterZ - listener.z;
    const waterDistance = Math.hypot(toWaterX, toWaterZ);
    const panRaw = waterDistance > 1e-6
      ? (toWaterX * Math.cos(listener.yaw) - toWaterZ * Math.sin(listener.yaw)) / waterDistance
      : 0;
    const waterPan = water > 0 ? Math.max(-1, Math.min(1, panRaw)) : 0;
    const wind = Math.max(0, Math.min(1, 0.25 + 0.65 * (1 - forest) + 0.1 * (1 - village)));
    return { wind, forest, village, water, waterPan };
  };

  const stats = (): AmbientAudioResolverStats => ({
    updates,
    waterSegments: waterSegments.length,
    treeInstances: treePoints.length,
    villageFootprints: footprints.length,
    lastWaterCandidates,
    lastTreeCandidates,
    lastVillageCandidates,
    maxWaterCandidates,
    maxTreeCandidates,
    maxVillageCandidates,
  });

  return { sample, stats };
}

/** Parse supplied datasets once, then build the local-query indexes. */
export function createAmbientAudioResolver(sources: AmbientAudioSources): AmbientAudioResolver {
  return buildAmbientAudioResolver(
    sources.water == null ? [] : parseWaterSegments(sources.water),
    sources.vegetation == null ? [] : parseTrees(sources.vegetation),
    sources.village == null ? [] : parseFootprints(sources.village),
  );
}

export interface LoadAudioEnvironmentOptions {
  readonly waterUrl: string | null;
  readonly vegetationUrl: string | null;
  readonly buildingsUrl: string | null;
}

async function fetchAmbientLayer(url: string | null, label: string): Promise<unknown | null> {
  if (url === null) return null;
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json() as unknown;
  } catch (error) {
    console.warn(`[audio-environment] ${label} ambience disabled: failed to load ${url}`, error);
    return null;
  }
}

function parsedLayer<T>(raw: unknown | null, label: string, parse: (value: unknown) => T): T | null {
  if (raw === null) return null;
  try {
    return parse(raw);
  } catch (error) {
    console.warn(`[audio-environment] ${label} ambience disabled: invalid source data`, error);
    return null;
  }
}

/** Fetch and validate each real data source once; unavailable layers warn and stay disabled. */
export async function loadAudioEnvironment(options: LoadAudioEnvironmentOptions): Promise<AmbientAudioResolver> {
  const [waterRaw, vegetationRaw, buildingsRaw] = await Promise.all([
    fetchAmbientLayer(options.waterUrl, 'water'),
    fetchAmbientLayer(options.vegetationUrl, 'forest'),
    fetchAmbientLayer(options.buildingsUrl, 'village'),
  ]);
  const water = parsedLayer(waterRaw, 'water', parseWaterSegments) ?? [];
  const vegetation = parsedLayer(vegetationRaw, 'forest', parseTrees) ?? [];
  const village = parsedLayer(buildingsRaw, 'village', parseFootprints) ?? [];
  return buildAmbientAudioResolver(water, vegetation, village);
}
