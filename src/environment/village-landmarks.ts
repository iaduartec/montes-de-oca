/**
 * Optional, small landmark GLBs. OSM/village and water geometry remain the
 * resilient fallback whenever a site asset cannot be loaded.
 */

import { SceneLoader } from '@babylonjs/core/Loading/sceneLoader';
import type { AssetContainer } from '@babylonjs/core/assetContainer';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import '@babylonjs/loaders/glTF';
import type { Scene } from '@babylonjs/core/scene';
import type { WorldTerrain } from '../terrain';

export interface VillageLandmarkStats {
  readonly sites: number;
  readonly meshes: number;
  readonly triangles: number;
  readonly bytes: number;
  readonly yawRad?: number;
  readonly baseM?: number;
}

export interface VillageLandmarks {
  readonly stats: VillageLandmarkStats;
  readonly coveredBuildingIds: ReadonlySet<number>;
  readonly replacesDam: boolean;
  dispose(): void;
}

export interface LoadVillageLandmarksOptions {
  readonly baseUrl?: string;
}

interface LandmarkAsset {
  readonly name: string;
  readonly file: string;
  readonly anchorX: number;
  readonly anchorZ: number;
  readonly bytes: number;
  readonly yawRad?: number;
  readonly baseM?: number;
  readonly coveredBuildingId?: number;
  readonly replacesDam?: boolean;
}

const ASSETS: readonly LandmarkAsset[] = [
  { name: 'iglesia', file: 'church.glb', anchorX: 3067.357, anchorZ: 3976.874, bytes: 30100, coveredBuildingId: 90614388 },
  { name: 'plaza', file: 'plaza.glb', anchorX: 3063.04, anchorZ: 4012.346, bytes: 12816 },
  { name: 'presa', file: 'dam.glb', anchorX: 2434.565, anchorZ: 1523.295, bytes: 9628, yawRad: -2.38742497, baseM: 1004, replacesDam: true },
];

function resetAndPlace(container: AssetContainer, asset: LandmarkAsset, terrain: WorldTerrain): number {
  let meshCount = 0;
  for (const mesh of container.meshes) {
    if (!(mesh instanceof Mesh) || mesh.getTotalVertices() === 0) continue;
    mesh.computeWorldMatrix(true);
    mesh.bakeTransformIntoVertices(mesh.getWorldMatrix().clone());
    mesh.setParent(null);
    mesh.position.set(0, 0, 0);
    mesh.rotation.set(0, 0, 0);
    mesh.rotationQuaternion = null;
    // Blender exports the local horizontal frame mirrored into the game.
    mesh.scaling.set(-1, 1, -1);
    mesh.bakeCurrentTransformIntoVertices();
    mesh.rotation.y = asset.yawRad ?? 0;
    const y = asset.baseM === undefined
      ? terrain.heightAt(asset.anchorX, asset.anchorZ)
      : asset.baseM - terrain.config.verticalDatum * terrain.config.worldScale;
    mesh.position.set(asset.anchorX, y, asset.anchorZ);
    mesh.scaling.set(1, 1, 1);
    mesh.refreshBoundingInfo(true);
    mesh.computeWorldMatrix(true);
    mesh.name = `hito:${asset.name}`;
    mesh.isPickable = false;
    mesh.checkCollisions = false;
    meshCount++;
  }
  if (meshCount === 0) throw new Error(`hito ${asset.name}: el GLB no contiene mallas visibles`);
  container.addAllToScene();
  return meshCount;
}

export async function loadVillageLandmarks(
  scene: Scene,
  terrain: WorldTerrain,
  options: LoadVillageLandmarksOptions = {},
): Promise<VillageLandmarks> {
  const baseUrl = options.baseUrl ?? '/village/focal-sites/';
  const containers: AssetContainer[] = [];
  const coveredBuildingIds = new Set<number>();
  let meshes = 0;
  let triangles = 0;
  let bytes = 0;
  let replacesDam = false;
  let sites = 0;

  for (const asset of ASSETS) {
    let container: AssetContainer | null = null;
    try {
      container = await SceneLoader.LoadAssetContainerAsync('', `${baseUrl}${asset.file}`, scene);
      const addedMeshes = resetAndPlace(container, asset, terrain);
      containers.push(container);
      meshes += addedMeshes;
      triangles += container.meshes.reduce((sum, mesh) => sum + (mesh instanceof Mesh ? mesh.getTotalIndices() / 3 : 0), 0);
      bytes += asset.bytes;
      sites++;
      if (asset.coveredBuildingId !== undefined) coveredBuildingIds.add(asset.coveredBuildingId);
      if (asset.replacesDam) replacesDam = true;
      console.info(`[hitos] ${asset.name}: ${addedMeshes} mallas cargadas`);
    } catch (error) {
      container?.dispose();
      console.warn(`[hitos] ${asset.name} no disponible; se mantiene la geometría base`, error);
    }
  }

  return {
    stats: { sites, meshes, triangles, bytes },
    coveredBuildingIds,
    replacesDam,
    dispose: () => {
      for (const container of containers) container.dispose();
    },
  };
}
