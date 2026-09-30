/** Small, animated village population placed beside the plaza road. */

import { SceneLoader } from '@babylonjs/core/Loading/sceneLoader';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh';
import type { AssetContainer, InstantiatedEntries } from '@babylonjs/core/assetContainer';
import type { Scene } from '@babylonjs/core/scene';
import '@babylonjs/loaders/glTF';
import type { WorldTerrain } from '../terrain';
import { villageNpcTierForDistance, VILLAGE_NPC_SPAWNS, type VillageNpcSimulationTier } from './village-npc-data';
import { generateVillageNpcWalkRoutes, type VillageNpcRoadLine, type VillageNpcRouteGeneration, type VillageNpcWalkRoute } from './village-npc-navigation';
import { createVillageNpcMotion, stepVillageNpcMotion, type VillageNpcMotionState } from './village-npc-motion';
export { VILLAGE_NPC_SPAWNS } from './village-npc-data';
export { villageNpcTierForDistance } from './village-npc-data';

export interface VillageNpcStats {
  readonly characters: number;
  readonly meshes: number;
  readonly triangles: number;
  readonly animations: number;
  readonly animationSamples: number;
  readonly tiers: Readonly<Record<VillageNpcSimulationTier, number>>;
  readonly routeValidation: {
    readonly candidatesPassed: number;
    readonly sampleStepM: number;
    readonly rejected: VillageNpcRouteGeneration['rejected'];
  };
}

export interface VillageNpcs {
  readonly stats: VillageNpcStats;
  /** Mallas renderizables humanas; los nodos raíz controlan el sleep por distancia. */
  readonly shadowCasters: readonly AbstractMesh[];
  /** Actualiza la visibilidad y animación según la distancia al jugador, en XZ. */
  update(observer: { readonly x: number; readonly z: number }, dt: number): void;
  dispose(): void;
}

export interface VillageNpcNavigationOptions {
  readonly roads: readonly VillageNpcRoadLine[];
  readonly buildingsUrl: string;
  readonly mappedWallsUrl: string;
  readonly waterDepthAt: (x: number, z: number) => number;
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
  navigation?: VillageNpcNavigationOptions,
): Promise<VillageNpcs> {
  if (!navigation) throw new Error('pueblo NPC requiere carreteras, edificios, muros y agua para validar rutas peatonales');
  const [buildingsResponse, wallsResponse] = await Promise.all([
    fetch(navigation.buildingsUrl),
    fetch(navigation.mappedWallsUrl),
  ]);
  if (!buildingsResponse.ok || !wallsResponse.ok) {
    throw new Error(`pueblo NPC no pudo leer datos de navegación (edificios ${buildingsResponse.status}, muros ${wallsResponse.status})`);
  }
  const [buildingsData, wallsData] = await Promise.all([buildingsResponse.json(), wallsResponse.json()]);
  if (!Array.isArray(buildingsData.buildings) || !Array.isArray(wallsData.walls) || navigation.roads.length === 0) {
    throw new Error('pueblo NPC recibió datos de navegación incompletos');
  }
  const routeGeneration = generateVillageNpcWalkRoutes({
    roads: navigation.roads,
    buildings: buildingsData.buildings,
    walls: wallsData.walls,
    waterDepthAt: navigation.waterDepthAt,
    heightAt: (x, z) => terrain.heightAt(x, z),
    normalAt: (x, z) => terrain.normalAt(x, z),
  });
  const walkingSpawns = routeGeneration.routes.map((route) => {
    const [a, b] = route.points;
    return { name: route.id, x: (a.x + b.x) / 2, z: (a.z + b.z) / 2, yaw: Math.atan2(b.x - a.x, b.z - a.z), route };
  });
  const spawns: Array<{ name: string; x: number; z: number; yaw: number; route?: VillageNpcWalkRoute }> = [
    ...VILLAGE_NPC_SPAWNS,
    ...walkingSpawns,
  ];
  const container: AssetContainer = await SceneLoader.LoadAssetContainerAsync('', assetUrl, scene);
  const instances: InstantiatedEntries[] = [];
  const roots: TransformNode[] = [];
  let meshes = 0;
  let triangles = 0;
  let animations = 0;
  const actors: Array<{
    root: TransformNode;
    idle: InstantiatedEntries['animationGroups'][number];
    x: number;
    z: number;
    tier: VillageNpcSimulationTier;
    sampleElapsedS: number;
    sampleFrame: number;
    animationSamples: number;
    walk: InstantiatedEntries['animationGroups'][number] | undefined;
    motion: VillageNpcMotionState | undefined;
    blend: number;
    moveElapsedS: number;
  }> = [];
  try {
    const sourceMeshes = container.meshes.filter((mesh) => mesh.getTotalVertices() > 0);
    const idle = container.animationGroups.find((group) => group.name.toLowerCase().includes('idle'));
    const walk = container.animationGroups.find((group) => group.name.toLowerCase().includes('walk'));
    if (sourceMeshes.length === 0 || !idle || !walk) throw new Error('GLB de NPC requiere malla humana y clips Idle y Walk');
    for (const spawn of spawns) {
      const entries = container.instantiateModelsToScene((sourceName) => `${spawn.name}:${sourceName}`);
      instances.push(entries);
      meshes += descendantsWithGeometry(entries).length;
      triangles += attach(entries, spawn.name, spawn.x, terrain.heightAt(spawn.x, spawn.z), spawn.z, spawn.yaw, scene, roots);
      const idle = entries.animationGroups.find((group) => group.name.toLowerCase().includes('idle'));
      const walk = spawn.route ? entries.animationGroups.find((group) => group.name.toLowerCase().includes('walk')) : undefined;
      const root = roots[roots.length - 1];
      if (!idle || !root) throw new Error(`pueblo NPC ${spawn.name}: instancia incompleta`);
      if (walk) {
        walk.start(true, 1, walk.from, walk.to, false);
        walk.pause();
        walk.setWeightForAllAnimatables(0);
      }
      if (walk) idle.setWeightForAllAnimatables(1);
      actors.push({ root, idle, walk, motion: spawn.route ? createVillageNpcMotion(spawn.route) : undefined, x: spawn.x, z: spawn.z, tier: 'FULL', sampleElapsedS: 0, sampleFrame: idle.getCurrentFrame(), animationSamples: 0, blend: 0, moveElapsedS: 0 });
      animations += walk ? 2 : 1;
    }
    console.info(`[pueblo NPC] ${spawns.length} vecinos animados · ${walkingSpawns.length} rutas validadas/${routeGeneration.candidateCount} candidatas · paso ${routeGeneration.sampleStepM} m · rechazos ${JSON.stringify(routeGeneration.rejected)} · ${meshes} mallas · ${triangles} triángulos`);
  } catch (error) {
    for (const root of roots) root.dispose(true, false);
    for (const entries of instances) entries.dispose();
    container.dispose();
    throw error;
  }

  const shadowCasters = instances.flatMap((entries) => descendantsWithGeometry(entries));

  return {
    shadowCasters,
    stats: {
      characters: spawns.length,
      meshes,
      triangles,
      animations,
      get animationSamples() {
        return actors.reduce((sum, actor) => sum + actor.animationSamples, 0);
      },
      get tiers() {
        return actors.reduce<Record<VillageNpcSimulationTier, number>>((counts, actor) => {
          counts[actor.tier] += 1;
          return counts;
        }, { FULL: 0, REDUCED: 0, VISUAL: 0, SLEEP: 0 });
      },
      routeValidation: {
        candidatesPassed: routeGeneration.candidateCount,
        sampleStepM: routeGeneration.sampleStepM,
        rejected: routeGeneration.rejected,
      },
    },
    update: (observer, dt) => {
      if (!Number.isFinite(observer.x) || !Number.isFinite(observer.z) || !Number.isFinite(dt) || dt <= 0) return;
      for (const actor of actors) {
        const distance = Math.hypot(observer.x - actor.x, observer.z - actor.z);
        const nextTier = villageNpcTierForDistance(distance);
        if (nextTier !== actor.tier) {
          actor.tier = nextTier;
          const asleep = nextTier === 'SLEEP';
          actor.root.setEnabled(!asleep);
          if (nextTier === 'FULL' || nextTier === 'REDUCED') {
            for (const group of [actor.idle, actor.walk]) if (group && !group.isStarted) group.start(true, 1, group.from, group.to, false);
            if (nextTier === 'FULL') for (const group of [actor.idle, actor.walk]) if (group?.isStarted && !group.isPlaying) group.play(true);
            actor.sampleFrame = actor.idle.getCurrentFrame();
            actor.sampleElapsedS = 0;
            if (nextTier === 'REDUCED') for (const group of [actor.idle, actor.walk]) group?.pause();
          } else for (const group of [actor.idle, actor.walk]) group?.pause();
        }

        if (actor.motion && (actor.tier === 'FULL' || actor.tier === 'REDUCED')) {
          actor.moveElapsedS += dt;
          const cadence = actor.tier === 'FULL' ? 0 : 0.2;
          if (cadence === 0 || actor.moveElapsedS >= cadence) {
            const stepDt = cadence === 0 ? Math.min(dt, 0.1) : Math.min(actor.moveElapsedS, 0.2);
            actor.moveElapsedS = cadence === 0 ? 0 : actor.moveElapsedS % cadence;
            const pose = stepVillageNpcMotion(actor.motion, stepDt);
            actor.x = pose.x;
            actor.z = pose.z;
            actor.root.position.x = pose.x;
            actor.root.position.y = terrain.heightAt(pose.x, pose.z);
            actor.root.position.z = pose.z;
            actor.root.rotation.y = pose.yaw;
            if (pose.changed) {
              actor.blend = 0;
              if (actor.tier === 'FULL') {
                const from = pose.mode === 'WALK' ? actor.idle : actor.walk;
                const to = pose.mode === 'WALK' ? actor.walk : actor.idle;
                if (from && to) {
                  from.pause();
                  if (to.isStarted) to.restart();
                  else to.start(true, 1, to.from, to.to, false);
                  to.setWeightForAllAnimatables(0);
                }
              }
            }
            if (pose.changed || actor.blend < 1) {
              actor.blend = Math.min(1, actor.blend + (cadence === 0 ? dt / 0.22 : stepDt / 0.22));
              const walking = actor.motion.mode === 'WALK';
              const active = walking ? actor.walk : actor.idle;
              const inactive = walking ? actor.idle : actor.walk;
              active?.setWeightForAllAnimatables(actor.blend);
              inactive?.setWeightForAllAnimatables(1 - actor.blend);
            }
          }
        }

        if (actor.tier === 'REDUCED') {
          actor.sampleElapsedS += dt;
          const sampleIntervalS = 0.2;
            const group = actor.motion?.mode === 'WALK' ? actor.walk ?? actor.idle : actor.idle;
            const framesPerSecond = group.targetedAnimations[0]?.animation.framePerSecond ?? 30;
            const frameSpan = Math.max(1, group.to - group.from);
          if (actor.sampleElapsedS >= sampleIntervalS) {
            actor.sampleElapsedS -= sampleIntervalS;
            // Drop excess catch-up after a long frame so reduced work stays bounded.
            actor.sampleElapsedS %= sampleIntervalS;
            actor.sampleFrame = group.from + ((actor.sampleFrame - group.from + sampleIntervalS * framesPerSecond) % frameSpan);
            group.goToFrame(actor.sampleFrame);
            actor.animationSamples += 1;
          }
        }
      }
    },
    dispose: () => {
      for (const root of roots) root.dispose(true, false);
      for (const entries of instances) entries.dispose();
      container.dispose();
    },
  };
}
