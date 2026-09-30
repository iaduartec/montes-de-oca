import { VertexBuffer } from '@babylonjs/core/Buffers/buffer';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial';
import { applyFacadeSurface, attachCampaSurface, CAMPA_TILE_METRES, FACADE_TILE_METRES, type FacadeSurfaceCache } from './facade-materials';
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
  { name: 'ermita-oca', file: '../oca-site/ermita.glb', anchorX: 2820.008064, anchorZ: 2122.016251, bytes: 156760, baseM: 972, coveredBuildingId: 216539679 },
  { name: 'campa-oca', file: '../oca-site/campa.glb', anchorX: 2834.475411, anchorZ: 2169.524367, bytes: 10784, baseM: 972 },
  { name: 'iglesia', file: 'church.glb', anchorX: 3067.357, anchorZ: 3976.874, bytes: 89792, coveredBuildingId: 90614388 },
  { name: 'plaza', file: 'plaza.glb', anchorX: 3063.04, anchorZ: 4012.346, bytes: 148624 },
  { name: 'presa', file: 'dam.glb', anchorX: 2440.325, anchorZ: 1513.065, bytes: 12332, baseM: 1010, replacesDam: true },
];

function resetAndPlace(container: AssetContainer, asset: LandmarkAsset, terrain: WorldTerrain, surfaceCache: FacadeSurfaceCache): number {
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
    if (asset.name === 'campa-oca' || asset.name === 'ermita-oca') {
      const positions = mesh.getVerticesData(VertexBuffer.PositionKind)!;
      const normals = mesh.getVerticesData(VertexBuffer.NormalKind)!;
      const uvs = new Float32Array(positions.length / 3 * 2);
      for (let i=0;i<positions.length;i+=3) {
        const nx = normals[i]!, ny = normals[i+1]!, nz = normals[i+2]!;
        const length = Math.hypot(nx, nz);
        if (mesh.material?.name === 'oca-roof' && Math.abs(ny) > 0.25 && length > 0.01) {
          const x = positions[i]! + asset.anchorX, z = positions[i+2]! + asset.anchorZ;
          uvs[i/3*2] = (x * nz - z * nx) / length / FACADE_TILE_METRES;
          uvs[i/3*2+1] = (x * nx + z * nz) / length / Math.abs(ny) / FACADE_TILE_METRES;
          continue;
        }
        const horizontal = asset.name === 'campa-oca' || Math.abs(normals[i+1]!) > 0.7;
        const repeat = asset.name === 'campa-oca' ? CAMPA_TILE_METRES : FACADE_TILE_METRES;
        uvs[i/3*2] = (horizontal || Math.abs(normals[i+2]!) >= Math.abs(normals[i]!) ? positions[i]!+asset.anchorX : positions[i+2]!+asset.anchorZ)/repeat;
        uvs[i/3*2+1] = (horizontal ? positions[i+2]!+asset.anchorZ : positions[i+1]!)/repeat;
      }
      mesh.setVerticesData(VertexBuffer.UVKind,uvs);
    }
    if (asset.name === 'campa-oca') mesh.hasVertexAlpha = true;
    mesh.name = `hito:${asset.name}`;
    mesh.isPickable = false;
    mesh.checkCollisions = false;
    meshCount++;
  }
  if (meshCount === 0) throw new Error(`hito ${asset.name}: el GLB no contiene mallas visibles`);
  if (asset.name === 'campa-oca' || asset.name === 'ermita-oca') {
    for (const material of container.materials) {
      if (!(material instanceof PBRMaterial)) continue;
      if (asset.name === 'campa-oca') {
        attachCampaSurface(material, material.getScene(), surfaceCache);
        material.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHABLEND;
      }
      else applyFacadeSurface(material, material.getScene(), surfaceCache);
    }
  }
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
  const surfaceCache: FacadeSurfaceCache = new Map();
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
      const addedMeshes = resetAndPlace(container, asset, terrain, surfaceCache);
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
      for (const textures of surfaceCache.values()) for (const texture of textures) texture.dispose();
    },
  };
}
