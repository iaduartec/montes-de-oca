import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import { Frustum } from '@babylonjs/core/Maths/math.frustum';
import type { Plane } from '@babylonjs/core/Maths/math.plane';
import type { Camera } from '@babylonjs/core/Cameras/camera';
import type { Scene } from '@babylonjs/core/scene';
import type { TerrainConfig } from './config';
import {
  assertValidGrid,
  containsPoint,
  createHeightfield,
  gridExtent,
  type HeightfieldGrid,
  type HeightfieldSampler,
  type TerrainSample,
} from './heightfield';

/**
 * Archivo de tile, EXACTAMENTE en el esquema de la referencia:
 * `{schemaVersion: 1, id, grid}`. Así el heightfield que exporta la FASE 2
 * (DEM IGN MDT05) se consume sin traducción ni renombres.
 *
 * `grid.heights` está en metros ABSOLUTOS (incluye la cota real). El
 * `verticalDatum` del config se resta recién al construir la malla y al
 * devolver `heightAt`, para no perder precisión de float en Y.
 */
export interface TerrainTileData {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly grid: HeightfieldGrid;
}

/** Paleta de altura para dar legibilidad visual sin depender de texturas. */
interface ColorStop {
  readonly at: number;
  readonly color: readonly [number, number, number];
}

const HEIGHT_COLOR_STOPS: readonly ColorStop[] = [
  { at: 0.0, color: [0.26, 0.42, 0.22] }, // valle / prado
  { at: 0.45, color: [0.42, 0.5, 0.27] }, // loma
  { at: 0.75, color: [0.55, 0.5, 0.4] }, // roca
  { at: 1.0, color: [0.78, 0.78, 0.8] }, // cima
];

function colorForHeight(normalized: number): readonly [number, number, number] {
  const t = Math.min(1, Math.max(0, normalized));
  let lo = HEIGHT_COLOR_STOPS[0]!;
  let hi = HEIGHT_COLOR_STOPS[HEIGHT_COLOR_STOPS.length - 1]!;
  for (let s = 0; s < HEIGHT_COLOR_STOPS.length - 1; s++) {
    const a = HEIGHT_COLOR_STOPS[s]!;
    const b = HEIGHT_COLOR_STOPS[s + 1]!;
    if (t >= a.at && t <= b.at) {
      lo = a;
      hi = b;
      break;
    }
  }
  const span = hi.at - lo.at;
  const k = span > 0 ? (t - lo.at) / span : 0;
  return [
    lo.color[0] + (hi.color[0] - lo.color[0]) * k,
    lo.color[1] + (hi.color[1] - lo.color[1]) * k,
    lo.color[2] + (hi.color[2] - lo.color[2]) * k,
  ];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseTile(raw: unknown, expectedId: string): TerrainTileData {
  if (!isRecord(raw)) throw new Error(`tile ${expectedId}: la raíz debe ser un objeto`);
  if (raw.schemaVersion !== 1) throw new Error(`tile ${expectedId}: schemaVersion no soportada`);
  if (typeof raw.id !== 'string') throw new Error(`tile ${expectedId}: falta "id"`);
  const rawGrid = raw.grid;
  if (!isRecord(rawGrid)) throw new Error(`tile ${expectedId}: falta "grid"`);
  const heights = rawGrid.heights;
  if (!Array.isArray(heights) || !heights.every((value) => typeof value === 'number' && Number.isFinite(value))) {
    throw new Error(`tile ${expectedId}: "heights" debe ser una lista de números finitos`);
  }
  const grid: HeightfieldGrid = {
    x0: rawGrid.x0 as number,
    z0: rawGrid.z0 as number,
    dx: rawGrid.dx as number,
    dz: rawGrid.dz as number,
    columns: rawGrid.columns as number,
    rows: rawGrid.rows as number,
    heights: heights as number[],
  };
  assertValidGrid(grid);
  return { schemaVersion: 1, id: raw.id, grid };
}

/** Entrada de culling: malla + su AABB en mundo (con el datum ya restado). */
interface TileMeshEntry {
  readonly id: string;
  readonly mesh: Mesh;
  readonly min: Vector3;
  readonly max: Vector3;
  readonly triangles: number;
}

/**
 * Construye la malla de un tile. La geometría sale del sampler (misma superficie
 * que usa la física): `Y = altura_metros * worldScale - verticalDatum * worldScale`.
 * Los colores se normalizan contra el rango de TODO el terreno (no por tile) para
 * que no aparezcan costuras entre tiles. Los índices son `u16` porque 201×201 =
 * 40.401 vértices < 65.535.
 */
function buildTileMesh(
  scene: Scene,
  tile: TerrainTileData,
  sampler: HeightfieldSampler,
  material: StandardMaterial,
  verticalDatum: number,
  globalMinMeters: number,
  globalMaxMeters: number,
): TileMeshEntry {
  const grid = tile.grid;
  const columns = grid.columns;
  const rows = grid.rows;
  const vertexCount = columns * rows;
  const datumOffset = verticalDatum * sampler.worldScale;
  const heightSpan = globalMaxMeters - globalMinMeters;

  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const colors = new Float32Array(vertexCount * 4);
  const uvs = new Float32Array(vertexCount * 2);

  const normalScratch = new Vector3();
  let p = 0;
  let n = 0;
  let c = 0;
  let t = 0;
  for (let j = 0; j < rows; j++) {
    const z = grid.z0 + j * grid.dz;
    for (let i = 0; i < columns; i++) {
      const x = grid.x0 + i * grid.dx;
      const meters = grid.heights[j * columns + i]!;

      positions[p++] = x;
      positions[p++] = meters * sampler.worldScale - datumOffset;
      positions[p++] = z;

      const normal = sampler.normalAt(x, z, normalScratch);
      normals[n++] = normal.x;
      normals[n++] = normal.y;
      normals[n++] = normal.z;

      const rgb = colorForHeight(heightSpan > 0 ? (meters - globalMinMeters) / heightSpan : 0);
      colors[c++] = rgb[0];
      colors[c++] = rgb[1];
      colors[c++] = rgb[2];
      colors[c++] = 1;

      uvs[t++] = i / (columns - 1);
      uvs[t++] = j / (rows - 1);
    }
  }

  // Dos triángulos por celda, partidos SW→NE igual que la interpolación.
  const indices = new Uint16Array((columns - 1) * (rows - 1) * 6);
  let q = 0;
  for (let j = 0; j < rows - 1; j++) {
    for (let i = 0; i < columns - 1; i++) {
      const sw = j * columns + i;
      const se = sw + 1;
      const nw = sw + columns;
      const ne = nw + 1;
      indices[q++] = sw;
      indices[q++] = ne;
      indices[q++] = se;
      indices[q++] = sw;
      indices[q++] = nw;
      indices[q++] = ne;
    }
  }

  const vertexData = new VertexData();
  vertexData.positions = positions;
  vertexData.normals = normals;
  vertexData.colors = colors;
  vertexData.uvs = uvs;
  vertexData.indices = indices;

  const mesh = new Mesh(`terrain:${tile.id}`, scene);
  vertexData.applyToMesh(mesh, false);
  mesh.material = material;
  mesh.useVertexColors = true;
  mesh.receiveShadows = true;
  mesh.isPickable = false;

  let tileMinMeters = Infinity;
  let tileMaxMeters = -Infinity;
  for (const height of grid.heights) {
    if (height < tileMinMeters) tileMinMeters = height;
    if (height > tileMaxMeters) tileMaxMeters = height;
  }

  return {
    id: tile.id,
    mesh,
    min: new Vector3(grid.x0, tileMinMeters - verticalDatum, grid.z0),
    max: new Vector3(
      grid.x0 + (columns - 1) * grid.dx,
      tileMaxMeters - verticalDatum,
      grid.z0 + (rows - 1) * grid.dz,
    ),
    triangles: (columns - 1) * (rows - 1) * 2,
  };
}

/** Distancia 3D mínima de un punto al AABB. 0 si está dentro. */
function distanceToBox(point: Vector3, min: Vector3, max: Vector3): number {
  const dx = Math.max(min.x - point.x, 0, point.x - max.x);
  const dy = Math.max(min.y - point.y, 0, point.y - max.y);
  const dz = Math.max(min.z - point.z, 0, point.z - max.z);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * Test conservador de AABB contra frustum por el "positive vertex" de cada plano.
 * Más fino que la esfera envolvente de Babylon (un tile de 1000 m tiene radio
 * ~707 m y sobreincluye esquinas que no se ven).
 */
function boxInFrustum(planes: readonly Plane[], min: Vector3, max: Vector3): boolean {
  for (const plane of planes) {
    const normal = plane.normal;
    const px = normal.x >= 0 ? max.x : min.x;
    const py = normal.y >= 0 ? max.y : min.y;
    const pz = normal.z >= 0 ? max.z : min.z;
    if (normal.x * px + normal.y * py + normal.z * pz + plane.d < 0) return false;
  }
  return true;
}

/** Mundo de terreno cargado: mallas + sampler unificado + culling. */
export interface WorldTerrain {
  readonly config: TerrainConfig;
  readonly meshes: readonly Mesh[];
  readonly samplers: readonly HeightfieldSampler[];
  /** Radio de vista en metros usado por `cull()`. */
  readonly viewRadius: number;
  /** Altura interpolada en unidades de mundo (datum ya restado). Fuera: 0. */
  heightAt(x: number, z: number): number;
  /** Normal del terreno por diferencias finitas. */
  normalAt(x: number, z: number, out?: Vector3): Vector3;
  /** Altura + normal juntas. */
  sampleHeight(x: number, z: number): TerrainSample;
  /** Activa/desactiva cada tile por distancia (AABB) + frustum. Devuelve cuántos quedaron. */
  cull(camera: Camera): number;
  /** Triángulos de los tiles actualmente habilitados. */
  activeTriangles(): number;
  /** Centro del área cubierta, en unidades de mundo. */
  center(): { x: number; z: number; height: number };
  dispose(): void;
}

function resolveSampler(samplers: readonly HeightfieldSampler[], x: number, z: number): HeightfieldSampler | undefined {
  for (const sampler of samplers) {
    if (containsPoint(sampler.grid, x, z)) return sampler;
  }
  // Si el punto cae afuera, se usa el tile más cercano para que la cámara o el
  // vehículo nunca queden sin referencia de altura.
  let best: HeightfieldSampler | undefined;
  let bestDistance = Infinity;
  for (const sampler of samplers) {
    const extent = gridExtent(sampler.grid);
    const dx = x - extent.centerX;
    const dz = z - extent.centerZ;
    const distance = dx * dx + dz * dz;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = sampler;
    }
  }
  return best;
}

/**
 * Carga todos los tiles declarados en el config, arma las mallas y devuelve el
 * mundo con culling por distancia + frustum. Los 36 tiles quedan en memoria (no
 * hay streaming ni LOD todavía); la visibilidad se resuelve con `setEnabled`.
 */
export async function loadTerrain(
  scene: Scene,
  config: TerrainConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<WorldTerrain> {
  const samplers: HeightfieldSampler[] = [];
  const tileData: TerrainTileData[] = [];

  for (const tileRef of config.tiles) {
    const response = await fetchImpl(tileRef.url);
    if (!response.ok) {
      throw new Error(`terrain: no se pudo cargar el tile "${tileRef.id}" (HTTP ${response.status})`);
    }
    const tile = parseTile((await response.json()) as unknown, tileRef.id);
    tileData.push(tile);
    samplers.push(createHeightfield(tile.grid, config.worldScale));
  }

  if (samplers.length === 0) throw new Error('terrain: el config no declaró ningún tile');

  let globalMinMeters = Infinity;
  let globalMaxMeters = -Infinity;
  for (const tile of tileData) {
    for (const height of tile.grid.heights) {
      if (height < globalMinMeters) globalMinMeters = height;
      if (height > globalMaxMeters) globalMaxMeters = height;
    }
  }

  const material = new StandardMaterial('terrain:material', scene);
  material.diffuseColor = new Color3(1, 1, 1);
  material.specularColor = new Color3(0.03, 0.03, 0.03);
  material.ambientColor = new Color3(0.2, 0.2, 0.2);
  // Winding del heightfield: se desactiva el back-face culling (un solo material).
  material.backFaceCulling = false;
  material.freeze();

  const entries: TileMeshEntry[] = [];
  for (let i = 0; i < tileData.length; i++) {
    entries.push(
      buildTileMesh(scene, tileData[i]!, samplers[i]!, material, config.verticalDatum, globalMinMeters, globalMaxMeters),
    );
  }

  const datumOffset = config.verticalDatum * config.worldScale;
  const firstSampler = samplers[0]!;

  const heightAt = (x: number, z: number): number => {
    const sampler = resolveSampler(samplers, x, z);
    return sampler ? sampler.heightAt(x, z) - datumOffset : 0;
  };

  const normalAt = (x: number, z: number, out?: Vector3): Vector3 => {
    const sampler = resolveSampler(samplers, x, z) ?? firstSampler;
    return sampler.normalAt(x, z, out);
  };

  const cull = (camera: Camera): number => {
    const planes = Frustum.GetPlanes(scene.getTransformMatrix());
    const position = camera.globalPosition;
    let enabled = 0;
    for (const entry of entries) {
      const visible =
        distanceToBox(position, entry.min, entry.max) <= config.viewRadius &&
        boxInFrustum(planes, entry.min, entry.max);
      entry.mesh.setEnabled(visible);
      if (visible) enabled++;
    }
    return enabled;
  };

  const activeTriangles = (): number => {
    let total = 0;
    for (const entry of entries) {
      if (entry.mesh.isEnabled()) total += entry.triangles;
    }
    return total;
  };

  const center = (): { x: number; z: number; height: number } => {
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const sampler of samplers) {
      const extent = gridExtent(sampler.grid);
      minX = Math.min(minX, extent.minX);
      maxX = Math.max(maxX, extent.maxX);
      minZ = Math.min(minZ, extent.minZ);
      maxZ = Math.max(maxZ, extent.maxZ);
    }
    const cx = (minX + maxX) / 2;
    const cz = (minZ + maxZ) / 2;
    return { x: cx, z: cz, height: heightAt(cx, cz) };
  };

  return {
    config,
    meshes: entries.map((entry) => entry.mesh),
    samplers,
    viewRadius: config.viewRadius,
    heightAt,
    normalAt,
    sampleHeight: (x, z) => ({ height: heightAt(x, z), normal: normalAt(x, z) }),
    cull,
    activeTriangles,
    center,
    dispose: () => {
      for (const entry of entries) entry.mesh.dispose();
      material.dispose();
    },
  };
}
