/** Small, animated village population placed beside the plaza road. */

import { SceneLoader } from '@babylonjs/core/Loading/sceneLoader';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh';
import type { AssetContainer, InstantiatedEntries } from '@babylonjs/core/assetContainer';
import type { Scene } from '@babylonjs/core/scene';
import '@babylonjs/loaders/glTF';
import type { WorldTerrain } from '../terrain';
import { VILLAGE_NPC_SPAWNS } from './village-npc-data';
export { VILLAGE_NPC_SPAWNS } from './village-npc-data';

export interface VillageNpcStats {
  readonly characters: number;
  readonly meshes: number;
  readonly triangles: number;
  readonly animations: number;
}

export interface VillageNpcs {
  readonly stats: VillageNpcStats;
  dispose(): void;
}

function descendantsWithGeometry(entries: InstantiatedEntries): AbstractMesh[] {
  const meshes: AbstractMesh[] = [];
  for (const root of entries.rootNodes) {
    if ('getTotalVertices' in root && typeof root.getTotalVertices === 'function' && root.getTotalVertices() > 0) {
      meshes.push(root as AbstractMesh);
    }
    for (const child of root.getDescendants(false)) {
      if ('getTotalVertices' in child && typeof child.getTotalVertices === 'function' && child.getTotalVertices() > 0) {
        meshes.push(child as AbstractMesh);
      }
    }
  }
  return meshes;
}

function attach(
  entries: InstantiatedEntries,
  name: string,
  x: number,
  y: number,
  z: number,
  yaw: number,
  scene: Scene,
  ownedRoots: TransformNode[],
): number {
  const root = new TransformNode(`pueblo:npc:${name}`, scene);
  ownedRoots.push(root);
  const modelRoots = entries.rootNodes.filter((node): node is TransformNode => node instanceof TransformNode);
  if (modelRoots.length === 0) throw new Error(`pueblo NPC ${name}: GLB sin raíz TransformNode`);
  for (const node of modelRoots) node.parent = root;

  root.computeWorldMatrix(true);
  const meshes = descendantsWithGeometry(entries);
  for (const mesh of meshes) mesh.computeWorldMatrix(true);
  const lowestY = Math.min(...meshes.map((mesh) => mesh.getBoundingInfo().boundingBox.minimumWorld.y));
  if (Number.isFinite(lowestY)) root.position.y += y - lowestY;
  root.position.x = x;
  root.position.z = z;
  root.rotation.y = yaw;
  root.computeWorldMatrix(true);

  for (const mesh of meshes) {
    mesh.isPickable = false;
    mesh.checkCollisions = false;
  }
  const idle = entries.animationGroups.find((group) => group.name.toLowerCase().includes('idle'));
  if (!idle) throw new Error(`pueblo NPC ${name}: GLB sin animación Idle`);
  idle.start(true, 1, idle.from, idle.to, false);
  return meshes.reduce((sum, mesh) => sum + Math.floor(mesh.getTotalIndices() / 3), 0);
}

export async function loadVillageNpcs(
  scene: Scene,
  terrain: WorldTerrain,
  assetUrl = '/characters/field-player.glb',
): Promise<VillageNpcs> {
  const container: AssetContainer = await SceneLoader.LoadAssetContainerAsync('', assetUrl, scene);
  const instances: InstantiatedEntries[] = [];
  const roots: TransformNode[] = [];
  let meshes = 0;
  let triangles = 0;
  let animations = 0;
  try {
    const sourceMeshes = container.meshes.filter((mesh) => mesh.getTotalVertices() > 0);
    const idle = container.animationGroups.find((group) => group.name.toLowerCase().includes('idle'));
    if (sourceMeshes.length === 0 || !idle) throw new Error('GLB de NPC requiere malla humana y animación Idle');
    for (const spawn of VILLAGE_NPC_SPAWNS) {
      const entries = container.instantiateModelsToScene((sourceName) => `${spawn.name}:${sourceName}`);
      instances.push(entries);
      meshes += descendantsWithGeometry(entries).length;
      triangles += attach(entries, spawn.name, spawn.x, terrain.heightAt(spawn.x, spawn.z), spawn.z, spawn.yaw, scene, roots);
      animations += entries.animationGroups.filter((group) => group.name.toLowerCase().includes('idle')).length;
    }
    console.info(`[pueblo NPC] ${VILLAGE_NPC_SPAWNS.length} vecinos animados · ${meshes} mallas · ${triangles} triángulos`);
  } catch (error) {
    for (const root of roots) root.dispose(true, false);
    for (const entries of instances) entries.dispose();
    container.dispose();
    throw error;
  }

  return {
    stats: { characters: VILLAGE_NPC_SPAWNS.length, meshes, triangles, animations },
    dispose: () => {
      for (const root of roots) root.dispose(true, false);
      for (const entries of instances) entries.dispose();
      container.dispose();
    },
  };
}
