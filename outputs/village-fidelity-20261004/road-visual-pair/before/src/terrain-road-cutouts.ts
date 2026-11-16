export interface RoadCutoutIndex {
  readonly triangles: Float32Array;
  readonly cellSize: number;
  readonly cells: ReadonlyMap<string, readonly number[]>;
  hasBounds(minX: number, maxX: number, minZ: number, maxZ: number): boolean;
}

export interface TerrainTriangleBuffers {
  readonly positions: ArrayLike<number>;
  readonly normals: ArrayLike<number>;
  readonly colors: ArrayLike<number>;
  readonly uvs: ArrayLike<number>;
  readonly indices: ArrayLike<number>;
}

export interface TerrainCutoutStats {
  readonly sourceTriangles: number;
  readonly clippedTriangles: number;
  readonly removedTriangles: number;
  readonly outputTriangles: number;
  readonly addedVertices: number;
  readonly removedAreaM2: number;
  readonly candidateTests: number;
}

export interface TerrainCutoutResult extends TerrainTriangleBuffers {
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly colors: Float32Array;
  readonly uvs: Float32Array;
  readonly indices: Uint16Array | Uint32Array;
  readonly stats: TerrainCutoutStats;
}

interface Vertex {
  readonly x: number;
  readonly z: number;
  readonly attributes: readonly number[];
  readonly sourceIndex: number | null;
}

interface CutTriangle {
  readonly ax: number;
  readonly az: number;
  readonly bx: number;
  readonly bz: number;
  readonly cx: number;
  readonly cz: number;
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
  readonly signedArea2: number;
  readonly winding: number;
}

const CLIP_EPSILON = 1e-8;
const AREA_EPSILON = 1e-9;

function cellKey(x: number, z: number): string {
  return `${x},${z}`;
}

function triangleAt(triangles: ArrayLike<number>, index: number): CutTriangle {
  const offset = index * 6;
  const ax = triangles[offset]!;
  const az = triangles[offset + 1]!;
  const bx = triangles[offset + 2]!;
  const bz = triangles[offset + 3]!;
  const cx = triangles[offset + 4]!;
  const cz = triangles[offset + 5]!;
  const area2 = (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
  return {
    ax, az, bx, bz, cx, cz,
    minX: Math.min(ax, bx, cx), maxX: Math.max(ax, bx, cx),
    minZ: Math.min(az, bz, cz), maxZ: Math.max(az, bz, cz),
    signedArea2: area2,
    winding: area2 >= 0 ? 1 : -1,
  };
}

/** Builds a spatial index over projected XZ triangles; the source stays immutable. */
export function createRoadCutoutIndex(triangles: Float32Array, cellSize = 5): RoadCutoutIndex | null {
  if (triangles.length % 6 !== 0) throw new Error('terrain cutouts: expected XZ triangle coordinates in groups of six');
  if (!Number.isFinite(cellSize) || cellSize <= 0) throw new Error('terrain cutouts: cellSize must be positive and finite');
  for (const coordinate of triangles) {
    if (!Number.isFinite(coordinate)) throw new Error('terrain cutouts: coordinates must be finite');
  }
  if (triangles.length === 0) return null;

  const mutableCells = new Map<string, number[]>();
  for (let i = 0; i < triangles.length / 6; i++) {
    const triangle = triangleAt(triangles, i);
    if (Math.abs(triangle.signedArea2) < AREA_EPSILON) continue;
    const x0 = Math.floor(triangle.minX / cellSize);
    const x1 = Math.floor(triangle.maxX / cellSize);
    const z0 = Math.floor(triangle.minZ / cellSize);
    const z1 = Math.floor(triangle.maxZ / cellSize);
    for (let x = x0; x <= x1; x++) {
      for (let z = z0; z <= z1; z++) {
        const key = cellKey(x, z);
        const list = mutableCells.get(key) ?? [];
        list.push(i);
        mutableCells.set(key, list);
      }
    }
  }

  return {
    triangles,
    cellSize,
    cells: mutableCells,
    hasBounds(minX, maxX, minZ, maxZ) {
      for (let x = Math.floor(minX / cellSize); x <= Math.floor(maxX / cellSize); x++) {
        for (let z = Math.floor(minZ / cellSize); z <= Math.floor(maxZ / cellSize); z++) {
          if (mutableCells.has(cellKey(x, z))) return true;
        }
      }
      return false;
    },
  };
}

function signedArea2(polygon: readonly Vertex[]): number {
  let area = 0;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i]!;
    const b = polygon[(i + 1) % polygon.length]!;
    area += a.x * b.z - b.x * a.z;
  }
  return area;
}

function polygonBounds(polygon: readonly Vertex[]) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const point of polygon) {
    minX = Math.min(minX, point.x); maxX = Math.max(maxX, point.x);
    minZ = Math.min(minZ, point.z); maxZ = Math.max(maxZ, point.z);
  }
  return { minX, maxX, minZ, maxZ };
}

function appendUnique(target: Vertex[], point: Vertex): void {
  const previous = target.at(-1);
  if (previous && Math.abs(previous.x - point.x) <= CLIP_EPSILON && Math.abs(previous.z - point.z) <= CLIP_EPSILON) return;
  target.push(point);
}

function interpolate(a: Vertex, b: Vertex, t: number): Vertex {
  return {
    x: a.x + (b.x - a.x) * t,
    z: a.z + (b.z - a.z) * t,
    attributes: a.attributes.map((value, index) => value + (b.attributes[index]! - value) * t),
    sourceIndex: null,
  };
}

function clipHalfPlane(
  polygon: readonly Vertex[],
  ax: number,
  az: number,
  bx: number,
  bz: number,
  winding: number,
  keepInside: boolean,
): Vertex[] {
  const out: Vertex[] = [];
  if (polygon.length === 0) return out;
  const signedDistance = (point: Vertex): number => winding * ((bx - ax) * (point.z - az) - (bz - az) * (point.x - ax));
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i]!;
    const b = polygon[(i + 1) % polygon.length]!;
    const da = signedDistance(a);
    const db = signedDistance(b);
    const aInside = keepInside ? da >= -CLIP_EPSILON : da <= CLIP_EPSILON;
    const bInside = keepInside ? db >= -CLIP_EPSILON : db <= CLIP_EPSILON;
    if (aInside !== bInside) {
      if (Math.abs(da) <= CLIP_EPSILON) appendUnique(out, a);
      else if (Math.abs(db) <= CLIP_EPSILON) appendUnique(out, b);
      else appendUnique(out, interpolate(a, b, da / (da - db)));
    }
    if (bInside) appendUnique(out, b);
  }
  if (out.length > 1 && Math.abs(out[0]!.x - out.at(-1)!.x) <= CLIP_EPSILON && Math.abs(out[0]!.z - out.at(-1)!.z) <= CLIP_EPSILON) out.pop();
  return out;
}

/** Subtracts a convex cutter triangle and returns disjoint convex remnants. */
function subtractTriangle(polygon: readonly Vertex[], cutter: CutTriangle): Vertex[][] {
  let inside: Vertex[] = [...polygon];
  const outside: Vertex[][] = [];
  const edges: readonly (readonly [number, number, number, number])[] = [
    [cutter.ax, cutter.az, cutter.bx, cutter.bz],
    [cutter.bx, cutter.bz, cutter.cx, cutter.cz],
    [cutter.cx, cutter.cz, cutter.ax, cutter.az],
  ];
  for (const [ax, az, bx, bz] of edges) {
    const out = clipHalfPlane(inside, ax, az, bx, bz, cutter.winding, false);
    if (out.length >= 3 && Math.abs(signedArea2(out)) > AREA_EPSILON) outside.push(out);
    inside = clipHalfPlane(inside, ax, az, bx, bz, cutter.winding, true);
    if (inside.length < 3) break;
  }
  return outside;
}

function createSourceVertex(buffers: TerrainTriangleBuffers, index: number): Vertex {
  const p = index * 3;
  const n = index * 3;
  const c = index * 4;
  const uv = index * 2;
  return {
    x: buffers.positions[p]!,
    z: buffers.positions[p + 2]!,
    attributes: [
      buffers.positions[p + 1]!,
      buffers.normals[n]!, buffers.normals[n + 1]!, buffers.normals[n + 2]!,
      buffers.colors[c]!, buffers.colors[c + 1]!, buffers.colors[c + 2]!, buffers.colors[c + 3]!,
      buffers.uvs[uv]!, buffers.uvs[uv + 1]!,
    ],
    sourceIndex: index,
  };
}

function candidateTrianglesInto(
  index: RoadCutoutIndex, minX: number, maxX: number, minZ: number, maxZ: number,
  candidates: number[], seen: Uint32Array, stamp: number,
): void {
  candidates.length = 0;
  for (let x = Math.floor(minX / index.cellSize); x <= Math.floor(maxX / index.cellSize); x++) {
    for (let z = Math.floor(minZ / index.cellSize); z <= Math.floor(maxZ / index.cellSize); z++) {
      const list = index.cells.get(cellKey(x, z));
      if (!list) continue;
      for (const candidate of list) {
        if (seen[candidate] !== stamp) {
          seen[candidate] = stamp;
          candidates.push(candidate);
        }
      }
    }
  }
}

function triangleBoundsOverlap(a: ReturnType<typeof polygonBounds>, b: CutTriangle): boolean {
  return a.maxX >= b.minX - CLIP_EPSILON && a.minX <= b.maxX + CLIP_EPSILON &&
    a.maxZ >= b.minZ - CLIP_EPSILON && a.minZ <= b.maxZ + CLIP_EPSILON;
}

function trianglesOverlap(a: readonly Vertex[], b: CutTriangle): boolean {
  const bx = [b.ax, b.bx, b.cx] as const;
  const bz = [b.az, b.bz, b.cz] as const;
  for (let source = 0; source < 2; source++) {
    for (let i = 0; i < 3; i++) {
      const j = (i + 1) % 3;
      const x1 = source === 0 ? a[i]!.x : bx[i]!;
      const z1 = source === 0 ? a[i]!.z : bz[i]!;
      const x2 = source === 0 ? a[j]!.x : bx[j]!;
      const z2 = source === 0 ? a[j]!.z : bz[j]!;
      const axisX = -(z2 - z1);
      const axisZ = x2 - x1;
      let aMin = Infinity, aMax = -Infinity, bMin = Infinity, bMax = -Infinity;
      for (const point of a) {
        const projection = point.x * axisX + point.z * axisZ;
        aMin = Math.min(aMin, projection); aMax = Math.max(aMax, projection);
      }
      for (let k = 0; k < 3; k++) {
        const projection = bx[k]! * axisX + bz[k]! * axisZ;
        bMin = Math.min(bMin, projection); bMax = Math.max(bMax, projection);
      }
      if (aMax < bMin - CLIP_EPSILON || bMax < aMin - CLIP_EPSILON) return false;
    }
  }
  return true;
}

function appendVertex(
  vertex: Vertex,
  positions: number[], normals: number[], colors: number[], uvs: number[],
  generatedVertices: Map<string, number>,
): number {
  if (vertex.sourceIndex !== null) return vertex.sourceIndex;
  const key = `${Math.round(vertex.x * 100000)},${Math.round(vertex.z * 100000)}`;
  const existing = generatedVertices.get(key);
  if (existing !== undefined) return existing;
  const index = positions.length / 3;
  positions.push(vertex.x, vertex.attributes[0]!, vertex.z);
  normals.push(vertex.attributes[1]!, vertex.attributes[2]!, vertex.attributes[3]!);
  colors.push(vertex.attributes[4]!, vertex.attributes[5]!, vertex.attributes[6]!, vertex.attributes[7]!);
  uvs.push(vertex.attributes[8]!, vertex.attributes[9]!);
  generatedVertices.set(key, index);
  return index;
}

function triangulatePolygon(
  polygon: readonly Vertex[],
  positions: number[], normals: number[], colors: number[], uvs: number[], indices: number[],
  generatedVertices: Map<string, number>,
): void {
  if (polygon.length < 3) return;
  const first = appendVertex(polygon[0]!, positions, normals, colors, uvs, generatedVertices);
  for (let i = 1; i < polygon.length - 1; i++) {
    const a = polygon[0]!;
    const b = polygon[i]!;
    const c = polygon[i + 1]!;
    const area2 = (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x);
    if (Math.abs(area2) <= AREA_EPSILON) continue;
    indices.push(first, appendVertex(b, positions, normals, colors, uvs, generatedVertices), appendVertex(c, positions, normals, colors, uvs, generatedVertices));
  }
}

/**
 * Cuts only source DEM triangle footprints overlapped by road triangles. The
 * remaining fragments retain linearly interpolated height, normal, color and UV.
 */
export function cutTerrainTriangles(source: TerrainTriangleBuffers, cutouts: RoadCutoutIndex): TerrainCutoutResult {
  if (source.positions.length % 3 || source.normals.length !== source.positions.length ||
      source.colors.length !== (source.positions.length / 3) * 4 || source.uvs.length !== (source.positions.length / 3) * 2 ||
      source.indices.length % 3) {
    throw new Error('terrain cutouts: source vertex buffers have inconsistent lengths');
  }

  let positions: number[] = [];
  let normals: number[] = [];
  let colors: number[] = [];
  let uvs: number[] = [];
  let indices: number[] = [];
  let hasOutput = false;
  let clippedTriangles = 0;
  let removedTriangles = 0;
  let removedAreaM2 = 0;
  let candidateTests = 0;
  const generatedVertices = new Map<string, number>();
  const sourceTriangles = source.indices.length / 3;
  const candidateList: number[] = [];
  const candidateSeen = new Uint32Array(cutouts.triangles.length / 6);
  let candidateStamp = 0;

  const ensureOutput = (beforeIndex: number): void => {
    if (hasOutput) return;
    positions = Array.from(source.positions);
    normals = Array.from(source.normals);
    colors = Array.from(source.colors);
    uvs = Array.from(source.uvs);
    for (let j = 0; j < beforeIndex; j++) indices.push(source.indices[j]!);
    hasOutput = true;
  };

  for (let i = 0; i < source.indices.length; i += 3) {
    const ia = source.indices[i]!;
    const ib = source.indices[i + 1]!;
    const ic = source.indices[i + 2]!;
    const pa = ia * 3, pb = ib * 3, pc = ic * 3;
    const minX = Math.min(source.positions[pa]!, source.positions[pb]!, source.positions[pc]!);
    const maxX = Math.max(source.positions[pa]!, source.positions[pb]!, source.positions[pc]!);
    const minZ = Math.min(source.positions[pa + 2]!, source.positions[pb + 2]!, source.positions[pc + 2]!);
    const maxZ = Math.max(source.positions[pa + 2]!, source.positions[pb + 2]!, source.positions[pc + 2]!);
    candidateStamp++;
    // A terrain tile has far fewer than 2^32 source triangles, so a single
    // monotonically increasing stamp avoids allocating a Set/list per DEM face.
    if (candidateStamp === 0xffffffff) { candidateSeen.fill(0); candidateStamp = 1; }
    candidateTrianglesInto(cutouts, minX, maxX, minZ, maxZ, candidateList, candidateSeen, candidateStamp);
    if (candidateList.length === 0) {
      if (hasOutput) indices.push(ia, ib, ic);
      continue;
    }

    const original = [createSourceVertex(source, ia), createSourceVertex(source, ib), createSourceVertex(source, ic)];
    const bounds = polygonBounds(original);
    let fragments: Vertex[][] = [original];
    const originalArea = Math.abs(signedArea2(original)) * 0.5;
    let triangleRemovedArea = 0;
    for (const candidateId of candidateList) {
      const cutter = triangleAt(cutouts.triangles, candidateId);
      if (!triangleBoundsOverlap(bounds, cutter)) continue;
      if (!trianglesOverlap(original, cutter)) continue;
      candidateTests++;
      const next: Vertex[][] = [];
      for (const fragment of fragments) {
        if (!triangleBoundsOverlap(polygonBounds(fragment), cutter)) {
          next.push(fragment);
          continue;
        }
        const outside = subtractTriangle(fragment, cutter);
        const remainingArea = outside.reduce((sum, polygon) => sum + Math.abs(signedArea2(polygon)) * 0.5, 0);
        const fragmentArea = Math.abs(signedArea2(fragment)) * 0.5;
        if (fragmentArea - remainingArea <= AREA_EPSILON) next.push(fragment);
        else {
          triangleRemovedArea += fragmentArea - remainingArea;
          next.push(...outside);
        }
      }
      fragments = next;
      if (fragments.length === 0) break;
    }

    if (triangleRemovedArea <= AREA_EPSILON) {
      if (hasOutput) indices.push(ia, ib, ic);
      continue;
    }

    ensureOutput(i);
    clippedTriangles++;
    removedAreaM2 += Math.min(originalArea, triangleRemovedArea);
    if (fragments.length === 0) removedTriangles++;
    for (const polygon of fragments) triangulatePolygon(polygon, positions, normals, colors, uvs, indices, generatedVertices);
  }

  if (!hasOutput) {
    return {
      positions: source.positions as Float32Array,
      normals: source.normals as Float32Array,
      colors: source.colors as Float32Array,
      uvs: source.uvs as Float32Array,
      indices: source.indices as Uint16Array | Uint32Array,
      stats: { sourceTriangles, clippedTriangles: 0, removedTriangles: 0, outputTriangles: sourceTriangles, addedVertices: 0, removedAreaM2: 0, candidateTests },
    };
  }
  let maxIndex = 0;
  for (const index of indices) maxIndex = Math.max(maxIndex, index);
  const outputIndices = maxIndex > 65535 ? new Uint32Array(indices) : new Uint16Array(indices);
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    colors: new Float32Array(colors),
    uvs: new Float32Array(uvs),
    indices: outputIndices,
    stats: {
      sourceTriangles,
      clippedTriangles,
      removedTriangles,
      outputTriangles: indices.length / 3,
      addedVertices: positions.length / 3 - source.positions.length / 3,
      removedAreaM2,
      candidateTests,
    },
  };
}
