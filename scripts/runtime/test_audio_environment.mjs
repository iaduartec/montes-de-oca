import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';

const bundle = await build({ entryPoints: ['src/runtime/audio-environment.ts'], bundle: true, platform: 'node', format: 'esm', write: false });
const runtime = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);
const { createAmbientAudioResolver, loadAudioEnvironment } = runtime;

const waterFixture = { schemaVersion: 1, ribbons: [{ points: [[50, 0, 1], [50, 50, 1]] }] };
const vegetationFixture = { meta: { schemaVersion: 1 }, instances: [
  { x: 0, z: 0, type: 'roble' }, { x: 20, z: 0, type: 'haya' }, { x: 0, z: 40, type: 'abedul' },
  { x: 1, z: 1, type: 'hierba' },
] };
const villageFixture = { meta: { schemaVersion: 1 }, buildings: [{ footprint: [[-5, -5], [5, -5], [5, 5], [-5, 5]] }] };
const resolver = createAmbientAudioResolver({ water: waterFixture, vegetation: vegetationFixture, village: villageFixture });
const near = resolver.sample({ x: 0, z: 0, yaw: 0 });
assert.equal(near.water, 1);
assert.equal(near.waterPan, 1, 'east water is on listener right when facing north');
assert.ok(near.forest > 0 && near.forest < 1, 'nearby trees add bounded forest density');
assert.equal(near.village, 1, 'listener inside a footprint receives village ambience');
const northWater = createAmbientAudioResolver({ water: { schemaVersion: 1, ribbons: [{ points: [[0, 50, 1], [50, 50, 1]] }] } });
const eastFacing = northWater.sample({ x: 0, z: 0, yaw: Math.PI / 2 });
assert.ok(eastFacing.waterPan < 0, 'north water is left when facing east');
assert.ok(eastFacing.waterPan > -1.01);
const at80 = resolver.sample({ x: 130, z: 25, yaw: 0 }).water;
const at140 = resolver.sample({ x: 190, z: 25, yaw: 0 }).water;
const at200 = resolver.sample({ x: 250, z: 25, yaw: 0 }).water;
assert.equal(at80, 1);
assert.ok(at140 > 0 && at140 < at80, 'water envelope fades smoothly through its configured range');
assert.equal(at200, 0);
assert.equal(resolver.sample({ x: 500, z: 500, yaw: 0 }).forest, 0);
assert.equal(resolver.sample({ x: 500, z: 500, yaw: 0 }).village, 0);
assert.throws(() => createAmbientAudioResolver({ water: { schemaVersion: 0, ribbons: [] } }), /schemaVersion/);
for (let i = 0; i < 600; i++) resolver.sample({ x: i % 20, z: i % 13, yaw: i / 100 });
assert.equal(resolver.stats().updates, 606);
assert.ok(resolver.stats().maxWaterCandidates <= 1);

const originalFetch = globalThis.fetch;
const originalWarn = console.warn;
let fetchCalls = [];
let warnings = [];
globalThis.fetch = async (url) => {
  fetchCalls.push(String(url));
  if (String(url).includes('fail')) return { ok: false, status: 503 };
  const body = String(url).includes('water') ? waterFixture : String(url).includes('trees') ? vegetationFixture : villageFixture;
  return { ok: true, json: async () => body };
};
console.warn = (...args) => warnings.push(args);
try {
  const loaded = await loadAudioEnvironment({ waterUrl: '/water', vegetationUrl: '/trees', buildingsUrl: '/buildings' });
  assert.deepEqual(fetchCalls.sort(), ['/buildings', '/trees', '/water']);
  assert.equal(loaded.sample({ x: 0, z: 0, yaw: 0 }).water, 1);
  fetchCalls = [];
  const disabled = await loadAudioEnvironment({ waterUrl: null, vegetationUrl: null, buildingsUrl: null });
  assert.equal(fetchCalls.length, 0, 'null URLs disable layers without network requests');
  assert.equal(disabled.sample({ x: 0, z: 0, yaw: 0 }).water, 0);
  const partial = await loadAudioEnvironment({ waterUrl: '/fail', vegetationUrl: '/trees', buildingsUrl: null });
  assert.equal(partial.sample({ x: 0, z: 0, yaw: 0 }).water, 0);
  assert.ok(partial.sample({ x: 0, z: 0, yaw: 0 }).forest > 0);
  assert.equal(warnings.length, 1, 'failed layer warns while valid layers remain available');
} finally {
  globalThis.fetch = originalFetch;
  console.warn = originalWarn;
}

const [waterData, vegetationData, buildingsData] = await Promise.all([
  readFile('public/water/water.json', 'utf8').then(JSON.parse),
  readFile('public/vegetation/vegetation.json', 'utf8').then(JSON.parse),
  readFile('public/village/buildings.json', 'utf8').then(JSON.parse),
]);
const real = createAmbientAudioResolver({ water: waterData, vegetation: vegetationData, village: buildingsData });
const firstWater = waterData.ribbons[0].points[0];
assert.equal(real.sample({ x: firstWater[0], z: firstWater[1], yaw: 0 }).water, 1, 'checked-in water geometry is indexed in world X/Z');
const firstFootprint = buildingsData.buildings[0].footprint;
const buildingCenter = firstFootprint.reduce((center, p) => [center[0] + p[0] / firstFootprint.length, center[1] + p[1] / firstFootprint.length], [0, 0]);
assert.equal(real.sample({ x: buildingCenter[0], z: buildingCenter[1], yaw: 0 }).village, 1, 'checked-in village footprints are queried in world X/Z');
assert.equal(real.stats().treeInstances, vegetationData.instances.filter((i) => ['roble', 'haya', 'abedul', 'pino'].includes(i.type)).length);
const far = real.sample({ x: 9000, z: 9000, yaw: 0 });
assert.equal(far.water, 0);
assert.equal(far.forest, 0);
assert.equal(far.village, 0);
assert.ok(real.stats().maxTreeCandidates < real.stats().treeInstances, 'sampling consults local hash cells, not every tree');
console.log('PASS audio environment: indexed real layers, local bounded samples, distance envelopes, relative water pan, loader failure isolation and checked-in data');
