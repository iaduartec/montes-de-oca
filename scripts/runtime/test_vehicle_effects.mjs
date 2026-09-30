import assert from 'node:assert/strict';
import { build } from 'esbuild';

const root = process.cwd();
const bundle = async (entryPoint) => {
  const result = await build({ entryPoints: [entryPoint], bundle: true, platform: 'node', format: 'esm', write: false });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString('base64')}`);
};
const [{ createVehicleEffects }, { SURFACES }, { NullEngine }, { Scene }] = await Promise.all([
  bundle('src/runtime/vehicle-effects.ts'),
  bundle('src/world/surfaces.ts'),
  import('@babylonjs/core/Engines/nullEngine.js'),
  import('@babylonjs/core/scene.js'),
]);

const engine = new NullEngine();
const scene = new Scene(engine);
let textureCreations = 0;
let textureDisposals = 0;
const effects = createVehicleEffects(scene, {
  capacity: 64,
  createTexture: () => {
    textureCreations++;
    return { dispose: () => textureDisposals++ };
  },
});
const system = scene.particleSystems[0];
assert.ok(system, 'one native Babylon ParticleSystem is created');
assert.equal(system.getCapacity(), 64);
assert.equal(scene.transformNodes.length, 0, 'Vector3 emitter avoids allocating a scene node');
assert.equal(textureCreations, 1);

const input = (surface, extra = {}) => ({
  position: { x: 5, y: 2, z: 9 }, yaw: 0.4, speed: 12, slip: false, driving: true, surface, ...extra,
});
effects.update(input(SURFACES.ROAD));
assert.equal(effects.stats().emitRate, 0, 'road emits no dust');
assert.equal(system.isStarted(), false, 'no particle update loop runs while road dust is disabled');
effects.update(input(SURFACES.MUD));
assert.equal(effects.stats().emitRate, 0, 'mud emits no dust');
effects.update(input(SURFACES.TRACK, { driving: false }));
assert.equal(effects.stats().emitRate, 0, 'a parked vehicle emits no dust');
effects.update(input(SURFACES.TRACK, { speed: 0.5 }));
assert.equal(effects.stats().emitRate, 0, 'stationary movement emits no dust');

effects.update(input(SURFACES.TRACK));
const trackRate = effects.stats().emitRate;
assert.ok(trackRate > 0 && trackRate <= 48, 'track produces bounded dust emission');
assert.equal(system.isStarted(), true, 'particle pool starts when a dusty surface is driven');
effects.update(input(SURFACES.GRASS));
assert.ok(effects.stats().emitRate > 0 && effects.stats().emitRate < trackRate, 'grass uses its lower shared dust tuning');
effects.update(input(SURFACES.TRACK, { slip: true }));
assert.ok(effects.stats().emitRate > trackRate, 'slip raises emission rate');
effects.update(input(SURFACES.ROAD));
assert.equal(system.emitRate, 0, 'switching to road immediately stops new dust particles');
assert.equal(effects.stats().emitting, false, 'road no longer emits after off-road slip');

// Vehicle changes move this same system and keep the texture/system allocations fixed.
for (let i = 0; i < 300; i++) effects.update(input(SURFACES.PATH, {
  position: { x: 100 + i, y: 2, z: -i }, yaw: i / 100,
}));
assert.equal(scene.particleSystems.length, 1);
assert.equal(scene.particleSystems[0], system);
assert.equal(textureCreations, 1);
assert.equal(effects.stats().systems, 1);
assert.equal(effects.stats().capacity, 64);
assert.equal(effects.stats().sceneNodeAllocations, 0);
assert.ok(effects.stats().activeParticles <= effects.stats().capacity);

effects.dispose();
effects.dispose();
assert.equal(scene.particleSystems.length, 0);
assert.equal(textureDisposals, 1);
assert.equal(effects.stats().systems, 0);
assert.equal(effects.stats().textures, 0);
scene.dispose();
engine.dispose();
console.log('PASS vehicle effects: bounded native pool, ROAD/MUD gating, speed/grip/slip response, persistent reuse and disposal (NullEngine; particle rendering not exercised)');
