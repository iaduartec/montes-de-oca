import { Texture } from '@babylonjs/core/Materials/Textures/texture';
import type { Scene } from '@babylonjs/core/scene';
import type { ProjectedBounds } from './config';
import type { HeightfieldGrid } from './heightfield';

export interface TerrainOrthophotoManifest {
  readonly schemaVersion: 1;
  readonly asset: { readonly url: string; readonly mimeType: string; readonly width: number; readonly height: number };
  readonly coverage: { readonly crs: string; readonly eMin: number; readonly eMax: number; readonly nMin: number; readonly nMax: number; readonly pixelSizeM: number };
}

export type TerrainTileOrthophotoUV = Float32Array;
export type TerrainTextureFactory = (scene: Scene, url: string, onLoad: () => void, onError: () => void) => Texture;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function parseTerrainOrthophotoManifest(raw: unknown, bounds: ProjectedBounds): TerrainOrthophotoManifest {
  if (!record(raw) || raw.schemaVersion !== 1 || !record(raw.asset) || !record(raw.coverage)) {
    throw new Error('orthophoto: manifest schema invalid');
  }
  const asset = raw.asset;
  const coverage = raw.coverage;
  if (typeof asset.url !== 'string' || !asset.url.startsWith('/') || asset.url.startsWith('//') ||
      typeof asset.mimeType !== 'string' || !asset.mimeType.startsWith('image/') ||
      !finite(asset.width) || asset.width <= 0 || !finite(asset.height) || asset.height <= 0) {
    throw new Error('orthophoto: atlas asset invalid');
  }
  if (coverage.crs !== 'EPSG:25830' || ![coverage.eMin, coverage.eMax, coverage.nMin, coverage.nMax, coverage.pixelSizeM].every(finite) ||
      (coverage.eMax as number) <= (coverage.eMin as number) || (coverage.nMax as number) <= (coverage.nMin as number) ||
      (coverage.pixelSizeM as number) <= 0) {
    throw new Error('orthophoto: coverage invalid');
  }
  const epsilon = 1e-6;
  if (Math.abs((coverage.eMin as number) - bounds.e[0]) > epsilon || Math.abs((coverage.eMax as number) - bounds.e[1]) > epsilon ||
      Math.abs((coverage.nMin as number) - bounds.n[0]) > epsilon || Math.abs((coverage.nMax as number) - bounds.n[1]) > epsilon) {
    throw new Error('orthophoto: coverage bounds do not match terrain');
  }
  return {
    schemaVersion: 1,
    asset: { url: asset.url, mimeType: asset.mimeType, width: asset.width, height: asset.height },
    coverage: {
      crs: coverage.crs,
      eMin: coverage.eMin as number,
      eMax: coverage.eMax as number,
      nMin: coverage.nMin as number,
      nMax: coverage.nMax as number,
      pixelSizeM: coverage.pixelSizeM as number,
    },
  };
}

/** Grid coordinates are local world X/Z from the projected bounds' southwest origin. */
export function terrainTileOrthophotoUV(grid: HeightfieldGrid, bounds: ProjectedBounds): TerrainTileOrthophotoUV {
  const width = bounds.e[1] - bounds.e[0];
  const height = bounds.n[1] - bounds.n[0];
  if (!(width > 0 && height > 0) || grid.columns < 2 || grid.rows < 2) throw new Error('orthophoto: invalid grid or bounds');
  const uvs = new Float32Array(grid.columns * grid.rows * 2);
  let offset = 0;
  for (let row = 0; row < grid.rows; row++) {
    const v = (grid.z0 + row * grid.dz) / height;
    for (let col = 0; col < grid.columns; col++) {
      uvs[offset++] = (grid.x0 + col * grid.dx) / width;
      uvs[offset++] = v;
    }
  }
  return uvs;
}

export async function loadTerrainOrthophotoTexture(
  scene: Scene,
  manifestUrl: string,
  bounds: ProjectedBounds,
  fetchImpl: typeof fetch,
  createTexture: TerrainTextureFactory,
): Promise<Texture | null> {
  try {
    if (!manifestUrl.startsWith('/') || manifestUrl.startsWith('//')) return null;
    const response = await fetchImpl(manifestUrl);
    if (!response.ok) return null;
    const manifest = parseTerrainOrthophotoManifest(await response.json() as unknown, bounds);
    if (Math.max(manifest.asset.width, manifest.asset.height) > scene.getEngine().getCaps().maxTextureSize) return null;
    return await new Promise<Texture | null>((resolve) => {
      let settled = false;
      let texture: Texture | null = null;
      let outcome: boolean | null = null;
      const finish = (ok: boolean): void => {
        if (settled) return;
        if (!texture) { outcome = ok; return; }
        settled = true;
        resolve(ok ? texture : null);
      };
      try {
        texture = createTexture(scene, manifest.asset.url, () => finish(true), () => finish(false));
        if (outcome !== null) finish(outcome);
      } catch {
        settled = true;
        resolve(null);
      }
    });
  } catch {
    return null;
  }
}
