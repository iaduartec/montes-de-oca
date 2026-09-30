import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import { Texture } from '@babylonjs/core/Materials/Textures/texture';
import { Frustum } from '@babylonjs/core/Maths/math.frustum';
import type { Plane } from '@babylonjs/core/Maths/math.plane';
import type { Camera } from '@babylonjs/core/Cameras/camera';
import type { Scene } from '@babylonjs/core/scene';
import { FrameTaskQueue, type FrameTaskHandle, type FrameTaskRunStats } from './runtime/frame-task-queue';
import type { TerrainConfig } from './config';
import { loadTerrainOrthophotoTexture, terrainTileOrthophotoUV, type TerrainTextureFactory } from './terrain-orthophoto';
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
  mesh: Mesh | null;
  readonly min: Vector3;
  readonly max: Vector3;
  readonly triangles: number;
  buildHandle: FrameTaskHandle | null;
  wanted: boolean;
  state: 'UNLOADED' | 'QUEUED' | 'LOADING' | 'ACTIVE' | 'CACHED';
}

export interface TerrainResidencyStats {
  readonly totalTiles: number;
  readonly residentGpuMeshes: number;
  readonly unloadedTiles: number;
  readonly queuedTiles: number;
  readonly loadingTiles: number;
  readonly activeTiles: number;
  readonly cachedTiles: number;
  readonly residentTriangles: number;
  readonly retainedCpuHeightSamples: number;
  /** Float payload estimate only; excludes JS array/object overhead. */
  readonly retainedCpuHeightBytesEstimate: number;
  /** Position/normal/color/UV/index buffer estimate; excludes shared texture/material. */
  readonly residentGpuGeometryBytesEstimate: number;
  readonly taskFrames: number;
  readonly taskSteps: number;
  readonly taskOvershootFrames: number;
  readonly lastTaskFrameMs: number;
  readonly maxTaskFrameMs: number;
  readonly initialGeometryBuildMs: number;
}

/**
 * Construye la malla de un tile. La geometría sale del sampler (misma superficie
 * que usa la física): `Y = altura_metros * worldScale - verticalDatum * worldScale`.
 * Los colores se normalizan contra el rango de TODO el terreno (no por tile) para
 * que no aparezcan costuras entre tiles. Los índices son `u16` porque 201×201 =
 * 40.401 vértices < 65.535.
 */
function createTileMeshBuildTask(
  scene: Scene,
  tile: TerrainTileData,
  sampler: HeightfieldSampler,
  material: PBRMaterial,
  verticalDatum: number,
  globalMinMeters: number,
  globalMaxMeters: number,
  orthophotoUVs: Float32Array | null,
): { readonly step: () => boolean; readonly getMesh: () => Mesh } {
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
  let row = 0;
  let mesh: Mesh | null = null;
  const step = (): boolean => {
    const rowEnd = Math.min(rows, row + 6);
    for (; row < rowEnd; row++) {
      let p = row * columns * 3;
      let n = p;
      let c = row * columns * 4;
      let t = row * columns * 2;
      const z = grid.z0 + row * grid.dz;
      for (let i = 0; i < columns; i++) {
        const x = grid.x0 + i * grid.dx;
        const meters = grid.heights[row * columns + i]!;

        positions[p++] = x;
        positions[p++] = meters * sampler.worldScale - datumOffset;
        positions[p++] = z;

        const normal = sampler.normalAt(x, z, normalScratch);
        normals[n++] = normal.x;
        normals[n++] = normal.y;
        normals[n++] = normal.z;

        const alturaN = heightSpan > 0 ? (meters - globalMinMeters) / heightSpan : 0;
        const rgb = colorForHeight(alturaN);
        const pasto = Math.max(0, 1 - alturaN * 2.2);
        const k = 1 + pasto * 0.11 * Math.sin(x * 0.078 + z * 0.122) * Math.cos(z * 0.094 - x * 0.066);
        const verdor = 1 + pasto * 0.07 * Math.cos(x * 0.046 - z * 0.038);
        const macro = 1 + 0.07 * Math.sin(x * 0.022 + z * 0.031) * Math.cos(z * 0.028 - x * 0.017);
        colors[c++] = orthophotoUVs ? macro : rgb[0] * k;
        colors[c++] = orthophotoUVs ? macro : rgb[1] * k * verdor;
        colors[c++] = orthophotoUVs ? macro : rgb[2] * k * verdor;
        colors[c++] = 1;

        const uvIndex = (row * columns + i) * 2;
        uvs[t++] = orthophotoUVs ? orthophotoUVs[uvIndex]! : i / (columns - 1);
        uvs[t++] = orthophotoUVs ? orthophotoUVs[uvIndex + 1]! : row / (rows - 1);
      }
    }
    if (row < rows) return false;

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
    mesh = new Mesh(`terrain:${tile.id}`, scene);
    vertexData.applyToMesh(mesh, false);
    mesh.material = material;
    mesh.useVertexColors = true;
    mesh.receiveShadows = true;
    mesh.isPickable = false;
    return true;
  };
  return { step, getMesh: () => { if (!mesh) throw new Error(`terrain: tile ${tile.id} is not built`); return mesh; } };
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
  /** Advances cooperative mesh preparation. Call once just before scene.render(). */
  runDeferredTasks(budgetMs: number): FrameTaskRunStats;
  /** CPU height samples remain resident; byte counts are payload estimates, not heap/VRAM measurements. */
  residencyStats(): TerrainResidencyStats;
  /** Centro del área cubierta, en unidades de mundo. */
  center(): { x: number; z: number; height: number };
  dispose(): void;
}

/* ------------------------------------------------------------------------- *
 * FOOTGUN DOCUMENTADO: hay DOS funciones `heightAt` y NO devuelven lo mismo.
 *
 *   createHeightfield(grid, scale).heightAt(x, z)   -> m ABSOLUTOS (944.5484)
 *   terrain.heightAt(x, z)  (esta interfaz)          -> Y DE MUNDO (74.5484)
 *
 * `src/heightfield.ts` NO resta el datum (`surfaceMeters(...) * worldScale`).
 * `src/terrain.ts` SÍ lo resta al resolver el tile. Para apoyar el vehículo
 * sobre el suelo hay que usar SIEMPRE el de `terrain.ts` (Y de mundo); usar el
 * de `heightfield.ts` sin restar 870 deja el coche 870 m bajo tierra.
 *
 * `worldHeightFromSampler` es la ÚNICA traducción entre ambas y existe para
 * poder testear la invariante `mundo === absoluto − datum` con una aserción.
 * ------------------------------------------------------------------------- */

/** Traduce altura ABSOLUTA de un sampler de tile a Y de mundo (resta el datum). */
export function worldHeightFromSampler(
  sampler: HeightfieldSampler,
  datumOffset: number,
  x: number,
  z: number,
): number {
  return sampler.heightAt(x, z) - datumOffset;
}

/** Muestra del chequeo `absoluto vs mundo`. */
export interface DatumAuditSample {
  readonly tile: string;
  readonly x: number;
  readonly z: number;
  readonly absoluteM: number;
  readonly worldY: number;
  readonly diffM: number;
}

export interface DatumAuditReport {
  readonly verticalDatum: number;
  readonly samples: readonly DatumAuditSample[];
  readonly maxAbsDiffM: number;
  readonly ok: boolean;
}

/**
 * Verifica, en el WorldTerrain REAL y ya cargado, que los dos `heightAt`
 * difieren EXACTAMENTE en el `verticalDatum`. Los puntos deben caer dentro de
 * los tiles (nada de bordes). Si esto falla, algo rompió el datum.
 */
export function auditVerticalDatum(terrain: WorldTerrain, points: readonly { x: number; z: number }[]): DatumAuditReport {
  const datum = terrain.config.verticalDatum * terrain.config.worldScale;
  const samples: DatumAuditSample[] = [];
  let maxAbsDiffM = 0;
  for (const point of points) {
    const sampler = resolveSampler(terrain.samplers, point.x, point.z);
    if (!sampler) continue;
    const absoluteM = sampler.heightAt(point.x, point.z);
    const worldY = terrain.heightAt(point.x, point.z);
    const diffM = worldY - (absoluteM - datum);
    if (Math.abs(diffM) > maxAbsDiffM) maxAbsDiffM = Math.abs(diffM);
    samples.push({ tile: tileIdOf(terrain, sampler), x: point.x, z: point.z, absoluteM, worldY, diffM });
  }
  return { verticalDatum: datum, samples, maxAbsDiffM, ok: maxAbsDiffM < 1e-9 };
}

function tileIdOf(terrain: WorldTerrain, sampler: HeightfieldSampler): string {
  const index = terrain.samplers.indexOf(sampler);
  const extent = gridExtent(sampler.grid);
  return `tile_${Math.round(extent.minX / 1000)}_${Math.round(extent.minZ / 1000)}#${index}`;
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
 * Carga todos los heightfields CPU y construye al inicio las mallas GPU. En
 * ejecución libera/reconstruye solo mallas lejanas; los samplers permanecen
 * residentes porque alimentan física y capas del mundo.
 */
export async function loadTerrain(
  scene: Scene,
  config: TerrainConfig,
  fetchImpl: typeof fetch = fetch,
  options: { readonly createTexture?: TerrainTextureFactory } = {},
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

  const material = new PBRMaterial('terrain:material', scene);
  material.albedoColor = new Color3(1, 1, 1);
  material.metallic = 0;
  material.reflectivityColor = new Color3(0.04, 0.04, 0.04);
  material.roughness = 0.96;
  // Winding del heightfield: se desactiva el back-face culling (un solo material).
  material.backFaceCulling = false;
  let orthophotoLoaded = false;
  let orthophotoTexture: Texture | null = null;
  if (config.orthophotoManifestUrl) {
    const textureFactory: TerrainTextureFactory = options.createTexture ?? ((targetScene, url, onLoad, onError) =>
      new Texture(url, targetScene, false, true, Texture.TRILINEAR_SAMPLINGMODE, onLoad, onError));
    const texture = await loadTerrainOrthophotoTexture(scene, config.orthophotoManifestUrl, config.bounds, fetchImpl, textureFactory);
    if (texture) {
      // PNOA is color/albedo data. Keep it in sRGB while PBR lighting works in linear space.
      texture.gammaSpace = true;
      material.albedoTexture = texture;
      orthophotoTexture = texture;
      orthophotoLoaded = true;
    }
  }
  material.freeze();

  const queue = new FrameTaskQueue();
  const entries: TileMeshEntry[] = [];
  let initialGeometryBuildMs = 0;
  for (let i = 0; i < tileData.length; i++) {
    const tile = tileData[i]!;
    const grid = tile.grid;
    let tileMinMeters = Infinity;
    let tileMaxMeters = -Infinity;
    for (const height of grid.heights) {
      tileMinMeters = Math.min(tileMinMeters, height);
      tileMaxMeters = Math.max(tileMaxMeters, height);
    }
    const entry: TileMeshEntry = {
      id: tile.id,
      mesh: null,
      min: new Vector3(grid.x0, (tileMinMeters - config.verticalDatum) * config.worldScale, grid.z0),
      max: new Vector3(
        grid.x0 + (grid.columns - 1) * grid.dx,
        (tileMaxMeters - config.verticalDatum) * config.worldScale,
        grid.z0 + (grid.rows - 1) * grid.dz,
      ),
      triangles: (grid.columns - 1) * (grid.rows - 1) * 2,
      buildHandle: null,
      wanted: true,
      state: 'CACHED',
    };
    const build = createTileMeshBuildTask(
      scene, tile, samplers[i]!, material, config.verticalDatum, globalMinMeters, globalMaxMeters,
      orthophotoLoaded ? terrainTileOrthophotoUV(grid, config.bounds) : null,
    );
    const buildStarted = performance.now();
    while (!build.step()) { /* Initial resident set is prepared before the first render. */ }
    initialGeometryBuildMs += performance.now() - buildStarted;
    entry.mesh = build.getMesh();
    entries.push(entry);
  }

  const datumOffset = config.verticalDatum * config.worldScale;
  const firstSampler = samplers[0]!;
  let taskFrames = 0;
  let taskSteps = 0;
  let taskOvershootFrames = 0;
  let lastTaskFrameMs = 0;
  let maxTaskFrameMs = 0;

  const heightAt = (x: number, z: number): number => {
    const sampler = resolveSampler(samplers, x, z);
    return sampler ? worldHeightFromSampler(sampler, datumOffset, x, z) : 0;
  };

  const normalAt = (x: number, z: number, out?: Vector3): Vector3 => {
    const sampler = resolveSampler(samplers, x, z) ?? firstSampler;
    return sampler.normalAt(x, z, out);
  };

  const cull = (camera: Camera): number => {
    // Culling may run before Babylon's first render, or after the camera has
    // been moved by gameplay code. Force the matrices so position and frustum
    // describe the same current pose (also handles parented cameras).
    camera.getViewMatrix(true);
    camera.getProjectionMatrix(true);
    const planes = Frustum.GetPlanes(camera.getTransformationMatrix());
    const position = camera.globalPosition;
    let enabled = 0;
    const largestTileEdge = entries.reduce((largest, entry) => Math.max(largest, entry.max.x - entry.min.x, entry.max.z - entry.min.z), 0);
    const loadRadius = config.viewRadius + largestTileEdge * 0.25;
    const unloadRadius = loadRadius + largestTileEdge * 0.5;
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index]!;
      const tileDistance = distanceToBox(position, entry.min, entry.max);
      if (entry.wanted ? tileDistance > unloadRadius : tileDistance <= loadRadius) entry.wanted = !entry.wanted;

      if (!entry.wanted) {
        entry.buildHandle?.cancel();
        entry.buildHandle = null;
        if (entry.mesh) {
          entry.mesh.dispose(false, false);
          entry.mesh = null;
        }
        entry.state = 'UNLOADED';
        continue;
      }

      if (!entry.mesh && !entry.buildHandle) {
        const tile = tileData[index]!;
        let build: ReturnType<typeof createTileMeshBuildTask> | null = null;
        entry.buildHandle = queue.enqueue({
          get priority() {
            // Queued work follows the live camera pose, so fast relocation
            // reprioritizes the newly-near tile on the next frame.
            return Math.max(0, config.viewRadius - distanceToBox(camera.globalPosition, entry.min, entry.max));
          },
          estimatedCostMs: Math.max(0.01, initialGeometryBuildMs / Math.max(1, entries.length)),
          step: () => {
            build ??= createTileMeshBuildTask(
              scene, tile, samplers[index]!, material, config.verticalDatum, globalMinMeters, globalMaxMeters,
              orthophotoLoaded ? terrainTileOrthophotoUV(tile.grid, config.bounds) : null,
            );
            if (entry.state === 'QUEUED') entry.state = 'LOADING';
            const done = build.step();
            if (done) {
              entry.mesh = build.getMesh();
              entry.mesh.setEnabled(false);
              entry.buildHandle = null;
              entry.state = 'CACHED';
            }
            return done;
          },
          onError: () => {
            entry.buildHandle = null;
            entry.state = 'UNLOADED';
          },
        });
        entry.state = 'QUEUED';
      }

      const visible = Boolean(entry.mesh) && tileDistance <= config.viewRadius && boxInFrustum(planes, entry.min, entry.max);
      entry.mesh?.setEnabled(visible);
      if (entry.mesh) entry.state = visible ? 'ACTIVE' : 'CACHED';
      if (visible) enabled++;
    }
    return enabled;
  };

  const activeTriangles = (): number => {
    let total = 0;
    for (const entry of entries) {
      if (entry.mesh?.isEnabled()) total += entry.triangles;
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
    get meshes() { return entries.flatMap((entry) => entry.mesh ? [entry.mesh] : []); },
    samplers,
    viewRadius: config.viewRadius,
    heightAt,
    normalAt,
    sampleHeight: (x, z) => ({ height: heightAt(x, z), normal: normalAt(x, z) }),
    cull,
    activeTriangles,
    runDeferredTasks: (budgetMs) => {
      const stats = queue.runFrame(budgetMs);
      taskFrames++;
      taskSteps += stats.executedSteps;
      if (stats.overshotBudget) taskOvershootFrames++;
      lastTaskFrameMs = stats.spentMs;
      maxTaskFrameMs = Math.max(maxTaskFrameMs, stats.spentMs);
      return stats;
    },
    residencyStats: () => {
      let residentGpuMeshes = 0;
      let residentTriangles = 0;
      let residentGpuGeometryBytesEstimate = 0;
      let unloadedTiles = 0;
      let queuedTiles = 0;
      let loadingTiles = 0;
      let activeTiles = 0;
      let cachedTiles = 0;
      for (const entry of entries) {
        if (entry.state === 'UNLOADED') unloadedTiles++;
        else if (entry.state === 'QUEUED') queuedTiles++;
        else if (entry.state === 'LOADING') loadingTiles++;
        else if (entry.state === 'ACTIVE') activeTiles++;
        else if (entry.state === 'CACHED') cachedTiles++;
        if (!entry.mesh) continue;
        residentGpuMeshes++;
        residentTriangles += entry.triangles;
        const grid = tileData.find((item) => item.id === entry.id)!.grid;
        const vertices = grid.columns * grid.rows;
        const indices = (grid.columns - 1) * (grid.rows - 1) * 6;
        residentGpuGeometryBytesEstimate += vertices * (3 + 3 + 4 + 2) * 4 + indices * 2;
      }
      const retainedCpuHeightSamples = samplers.reduce((sum, sampler) => sum + sampler.grid.heights.length, 0);
      return {
        totalTiles: entries.length,
        residentGpuMeshes,
        unloadedTiles,
        queuedTiles,
        loadingTiles,
        activeTiles,
        cachedTiles,
        residentTriangles,
        retainedCpuHeightSamples,
        retainedCpuHeightBytesEstimate: retainedCpuHeightSamples * 8,
        residentGpuGeometryBytesEstimate,
        taskFrames,
        taskSteps,
        taskOvershootFrames,
        lastTaskFrameMs,
        maxTaskFrameMs,
        initialGeometryBuildMs,
      };
    },
    center,
    dispose: () => {
      queue.dispose();
      for (const entry of entries) {
        entry.buildHandle?.cancel();
        entry.mesh?.dispose(false, false);
      }
      material.dispose();
      orthophotoTexture?.dispose?.();
    },
  };
}
