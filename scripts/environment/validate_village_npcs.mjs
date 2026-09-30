import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { build } from 'esbuild';
import { VILLAGE_NPC_SPAWNS, villageNpcTierForDistance } from '../../src/environment/village-npc-data.ts';

const roads = JSON.parse(readFileSync('public/roads/roads.json', 'utf8')).roads;
const buildings = JSON.parse(readFileSync('public/village/buildings.json', 'utf8')).buildings;

function pointSegmentDistance(point, a, b) {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const lengthSquared = dx * dx + dz * dz;
  const t = lengthSquared > 0
    ? Math.max(0, Math.min(1, ((point.x - a[0]) * dx + (point.z - a[1]) * dz) / lengthSquared))
    : 0;
  return Math.hypot(point.x - a[0] - dx * t, point.z - a[1] - dz * t);
}

function pointInPolygon(point, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, zi] = polygon[i];
    const [xj, zj] = polygon[j];
    if ((zi > point.z) !== (zj > point.z) && point.x < ((xj - xi) * (point.z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

function polygonDistance(point, polygon) {
  if (pointInPolygon(point, polygon)) return 0;
  return Math.min(...polygon.map((a, i) => pointSegmentDistance(point, a, polygon[(i + 1) % polygon.length])));
}

assert.equal(VILLAGE_NPC_SPAWNS.length, 2, 'se conservan las dos posiciones originales');
assert.deepEqual(
  [80, 80.01, 250, 250.01, 900, 900.01].map(villageNpcTierForDistance),
  ['FULL', 'REDUCED', 'REDUCED', 'VISUAL', 'VISUAL', 'SLEEP'],
  'distancia XZ elige los cuatro tiers con límites estables',
);
assert.equal(villageNpcTierForDistance(Number.NaN), 'SLEEP', 'distancia inválida duerme el actor');
for (const npc of VILLAGE_NPC_SPAWNS) {
  const nearbyPlazaRoad = roads
    .filter((road) => road.class === 'ROAD' && road.name === 'La Plaza')
    .flatMap((road) => road.points.slice(1).map((point, i) => ({ road, a: road.points[i], b: point })))
    .map(({ road, a, b }) => ({ road, distance: pointSegmentDistance(npc, a, b) - road.width / 2 }))
    .sort((a, b) => Math.abs(a.distance) - Math.abs(b.distance))[0];
  assert.ok(nearbyPlazaRoad && nearbyPlazaRoad.distance >= 0.5 && nearbyPlazaRoad.distance <= 1.5, `${npc.name} sits just outside La Plaza road`);
  const buildingClearance = Math.min(...buildings.map((building) => polygonDistance(npc, building.footprint)));
  assert.ok(buildingClearance >= 2, `${npc.name} clears nearby building footprints by ${buildingClearance.toFixed(2)} m`);
}

const asset = 'public/characters/field-player.glb';
assert.ok(statSync(asset).size > 100_000, 'NPCs reuse the checked-in animated human GLB');
const glb = readFileSync(asset);
const jsonLength = glb.readUInt32LE(12);
const gltf = JSON.parse(glb.toString('utf8', 20, 20 + jsonLength));
const animationNames = gltf.animations.map((animation) => animation.name);
assert.ok(animationNames.some((name) => name.toLowerCase().includes('idle')), 'asset has authored Idle');
assert.ok(animationNames.some((name) => name.toLowerCase().includes('walk')), 'asset has retargeted Walk available');
assert.match(readFileSync('assets/characters/kenney-animated-characters-3/source/License.txt', 'utf8'), /Creative Commons Zero, CC0/);
assert.match(readFileSync('src/environment/village-npcs.ts', 'utf8'), /includes\('idle'\)/i, 'each NPC starts the authored idle clip');
assert.match(readFileSync('src/environment/village-npcs.ts', 'utf8'), /actor\.root\.setEnabled\(!asleep\)/, 'SLEEP suspends distant NPC roots');

// Exercise the actual GLB instances and their LOD lifecycle in Babylon NullEngine.
const runtimeBundle = await build({
  stdin: {
    contents: `export { NullEngine } from '@babylonjs/core/Engines/nullEngine.js';\nexport { FreeCamera } from '@babylonjs/core/Cameras/freeCamera.js';\nexport { Scene } from '@babylonjs/core/scene.js';\nexport { Vector3 } from '@babylonjs/core/Maths/math.vector.js';\nexport { loadVillageNpcs } from './src/environment/village-npcs.ts';\nexport { generateVillageNpcWalkRoutes } from './src/environment/village-npc-navigation.ts';\nexport { createHeightfield } from './src/heightfield.ts';\nexport { loadWater } from './src/environment/water.ts';`,
    resolveDir: process.cwd(),
    sourcefile: 'village-npc-null-engine-harness.ts',
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
});
const runtimeCode = Buffer.from(runtimeBundle.outputFiles[0].contents).toString('base64');
const runtime = await import(`data:text/javascript;base64,${runtimeCode}`);
const { NullEngine, FreeCamera, Scene, Vector3, loadVillageNpcs, generateVillageNpcWalkRoutes, createHeightfield, loadWater } = runtime;
const engine = new NullEngine();
const scene = new Scene(engine);
const camera = new FreeCamera('npc-validation-camera', new Vector3(3060, 3, 4005), scene);
camera.setTarget(new Vector3(3060, 0, 4005));
scene.activeCamera = camera;
const assetUrl = `data:application/octet-stream;base64,${readFileSync(asset).toString('base64')}`;
const terrainConfig = JSON.parse(readFileSync('public/terrain/config.json', 'utf8'));
const terrainSamplers = ['tile_2_3', 'tile_3_3', 'tile_2_4', 'tile_3_4'].map((id) => createHeightfield(JSON.parse(readFileSync(`public/terrain/tiles/${id}.json`, 'utf8')).grid, 1));
const samplerAt = (x, z) => terrainSamplers.find((sampler) => x >= sampler.grid.x0 && x <= sampler.grid.x0 + (sampler.grid.columns - 1) * sampler.grid.dx && z >= sampler.grid.z0 && z <= sampler.grid.z0 + (sampler.grid.rows - 1) * sampler.grid.dz);
const terrain = {
  samplers: terrainSamplers,
  config: { verticalDatum: terrainConfig.verticalDatum, worldScale: terrainConfig.worldScale },
  heightAt: (x, z) => { const sampler = samplerAt(x, z); return sampler ? sampler.heightAt(x, z) - terrainConfig.verticalDatum : Number.NaN; },
  normalAt: (x, z) => samplerAt(x, z)?.normalAt(x, z) ?? { x: Number.NaN, y: Number.NaN, z: Number.NaN },
};
const waterJson = readFileSync('public/water/water.json', 'utf8');
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url) => String(url).includes('npc-buildings')
  ? new Response(readFileSync('public/village/buildings.json', 'utf8'))
  : String(url).includes('npc-walls')
    ? new Response(readFileSync('public/village/mapped-walls.json', 'utf8'))
    : new Response(waterJson);
const water = await loadWater(scene, terrain, { url: 'npc-water' });
const roadsForNpc = roads.map((road) => ({ id: String(road.id), class: road.class, width: road.width, points: road.points }));
const navigationSources = {
  roads: roadsForNpc,
  buildings,
  walls: JSON.parse(readFileSync('public/village/mapped-walls.json', 'utf8')).walls,
  waterDepthAt: water.depthAt,
  heightAt: terrain.heightAt,
  normalAt: terrain.normalAt,
};
const generated = generateVillageNpcWalkRoutes(navigationSources);
assert.equal(generated.routes.length, 8, 'ocho recorridos pasan muestras de obstáculo, terreno y agua reales');
assert.equal(generated.sampleStepM, 0.25);
assert.throws(() => generateVillageNpcWalkRoutes({ ...navigationSources, walls: [{ points: [[0, 0], [1, 1]], widthM: Number.NaN }] }), /invalid mapped wall/i);
assert.ok(generated.routes.every((route) => route.lengthM >= 3.99 && route.lengthM <= 4.01));
for (const route of generated.routes) {
  const [a, b] = route.points;
  const count = Math.ceil(route.lengthM / 0.25);
  for (let i = 0; i <= count; i += 1) {
    const t = i / count;
    const x = a.x + (b.x - a.x) * t;
    const z = a.z + (b.z - a.z) * t;
    assert.ok(Number.isFinite(terrain.heightAt(x, z)), `${route.id} remains inside real terrain coverage`);
    assert.equal(water.depthAt(x, z), 0, `${route.id} sample is dry`);
  }
}
const npcs = await loadVillageNpcs(scene, terrain, assetUrl, {
  roads: roadsForNpc,
  buildingsUrl: 'npc-buildings',
  mappedWallsUrl: 'npc-walls',
  waterDepthAt: water.depthAt,
});
assert.equal(npcs.stats.characters, 10, 'runtime loads ten animated NPCs');
assert.equal(npcs.stats.animations, 18, 'two original Idle actors and eight Idle/Walk actors');
assert.equal(npcs.shadowCasters.length, 10, 'the shadow interface exposes only the ten human draw meshes');
assert.equal(new Set(npcs.shadowCasters).size, npcs.shadowCasters.length, 'human shadow casters are unique');
assert.equal(npcs.stats.routeValidation.sampleStepM, 0.25, 'route validation samples no farther apart than 25 cm');
assert.equal(npcs.stats.routeValidation.candidatesPassed, generated.candidateCount);
const first = VILLAGE_NPC_SPAWNS[0];
const actorRoots = scene.transformNodes.filter((node) => node.name.startsWith('pueblo:npc:'));
assert.equal(actorRoots.length, 10);

npcs.update({ x: 0, z: 0 }, 0.1);
assert.equal(npcs.stats.tiers.SLEEP, 10, 'far NPCs sleep');
assert.ok(actorRoots.every((root) => !root.isEnabled()), 'sleep disables all actor roots');

npcs.update({ x: first.x, z: first.z }, 0.1);
assert.ok(npcs.stats.tiers.FULL >= 2, 'nearby villagers run at full animation rate');
const idleGroups = scene.animationGroups.filter((group) => group.name.toLowerCase().includes('idle'));
assert.equal(idleGroups.length, 10);
const originalIdleGroups = idleGroups.filter((group) => /vecino-0[12]/i.test(group.name));
assert.equal(originalIdleGroups.length, 2);
assert.ok(originalIdleGroups.every((group) => group.isPlaying));

const reducedObserver = { x: first.x + 110, z: first.z };
const reducedSamplesBefore = npcs.stats.animationSamples;
npcs.update(reducedObserver, 0.199);
const reducedSamplesAfter199ms = npcs.stats.animationSamples;
assert.ok(reducedSamplesAfter199ms >= reducedSamplesBefore, 'reduced pose sampling is monotonic');
const framesBeforeFirstReducedSample = originalIdleGroups.map((group) => group.getCurrentFrame());
npcs.update(reducedObserver, 0.001);
assert.ok(npcs.stats.tiers.REDUCED >= 2);
assert.ok(npcs.stats.animationSamples >= reducedSamplesAfter199ms, 'reduced NPCs advance sampled poses');
assert.ok(originalIdleGroups.some((group, index) => group.getCurrentFrame() !== framesBeforeFirstReducedSample[index]), 'sampled reduced updates advance the authored idle pose');
assert.ok(originalIdleGroups.every((group) => !group.isPlaying && group.isStarted), 'reduced groups are paused between sampled pose updates');
const beforeLongReducedFrame = npcs.stats.animationSamples;
npcs.update(reducedObserver, 1);
assert.ok(npcs.stats.animationSamples - beforeLongReducedFrame <= 10, 'long frames do not create an unbounded burst of pose samples');

npcs.update({ x: first.x + 310, z: first.z }, 0.1);
assert.ok(npcs.stats.tiers.VISUAL >= 2);
assert.ok(actorRoots.every((root) => root.isEnabled()), 'visual tier retains visible roots');
const visualFrames = originalIdleGroups.map((group) => group.getCurrentFrame());
npcs.update({ x: first.x + 1000, z: first.z }, 0.1);
assert.equal(npcs.stats.tiers.SLEEP, 10);
assert.ok(actorRoots.every((root) => !root.isEnabled()));
npcs.update({ x: first.x, z: first.z }, 0.1);
assert.ok(npcs.stats.tiers.FULL >= 2);
assert.ok(originalIdleGroups.every((group) => group.isPlaying), 'returning NPCs resume Idle');
assert.deepEqual(originalIdleGroups.map((group) => group.getCurrentFrame()), visualFrames, 'tier changes preserve the paused pose before full playback resumes');

let skeletonPreparations = 0;
let skeletonMatrixComputations = 0;
for (const skeleton of scene.skeletons) {
  const prepare = skeleton.prepare.bind(skeleton);
  skeleton.prepare = (...args) => { skeletonPreparations += 1; return prepare(...args); };
  const compute = skeleton._computeTransformMatrices.bind(skeleton);
  skeleton._computeTransformMatrices = (...args) => { skeletonMatrixComputations += 1; return compute(...args); };
}
for (let frame = 0; frame < 30; frame += 1) scene.render();
const fullTierMatrixComputations = skeletonMatrixComputations;
const reducedObserverForMeasure = { x: first.x + 110, z: first.z };
npcs.update(reducedObserverForMeasure, 0.2);
const reducedStartMatrixComputations = skeletonMatrixComputations;
for (let frame = 0; frame < 30; frame += 1) {
  npcs.update(reducedObserverForMeasure, 1 / 60);
  scene.render();
}
const reducedTierMatrixComputations = skeletonMatrixComputations - reducedStartMatrixComputations;
console.log(`NPC NullEngine sample: ${scene.skeletons.length} skeletons; full tier ${fullTierMatrixComputations} bone-matrix computes / 30 renders; reduced tier ${reducedTierMatrixComputations} / 30 renders; ${npcs.stats.animationSamples} sampled pose updates; ${skeletonPreparations} prepare calls`);
assert.ok(reducedTierMatrixComputations <= fullTierMatrixComputations, 'reduced tier does not increase bone-matrix computations');
const movingRoute = generated.routes[0];
const movingNpc = scene.transformNodes.find((node) => node.name === 'pueblo:npc:vecino-03');
assert.ok(movingNpc, 'the first route generated a real NPC instance');
const routeObserver = { x: (movingRoute.points[0].x + movingRoute.points[1].x) / 2, z: (movingRoute.points[0].z + movingRoute.points[1].z) / 2 };
const initialRouteActorX = movingNpc.position.x;
const initialRouteActorZ = movingNpc.position.z;
let maximumRouteDisplacement = 0;
for (let frame = 0; frame < 180; frame += 1) {
  npcs.update(routeObserver, 0.1);
  maximumRouteDisplacement = Math.max(maximumRouteDisplacement, Math.hypot(movingNpc.position.x - initialRouteActorX, movingNpc.position.z - initialRouteActorZ));
}
assert.ok(maximumRouteDisplacement > 0.2, 'the route NPC walks without GLB root motion');
assert.ok(Math.abs(movingNpc.position.y - terrain.heightAt(movingNpc.position.x, movingNpc.position.z)) < 1e-5, 'moving NPC remains grounded on the sampled terrain');
npcs.dispose();
assert.equal(scene.animationGroups.length, 0, 'disposal releases cloned animation groups');
assert.equal(scene.meshes.length, water.stats.meshes, 'disposal releases instantiated character meshes');
water.dispose();
assert.equal(scene.meshes.length, 0, 'water and NPC validation fixtures dispose their meshes');
scene.dispose();
engine.dispose();
globalThis.fetch = originalFetch;
console.log('village NPC placement, tiers, sampled animation and disposal: OK');
