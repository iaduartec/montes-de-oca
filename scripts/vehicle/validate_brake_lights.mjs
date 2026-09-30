import assert from 'node:assert/strict';
import { build } from 'esbuild';

const bundle = await build({
  entryPoints: ['src/vehicle/four-wheel.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
});
const vehicleModule = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);
const { NullEngine } = await import('@babylonjs/core/Engines/nullEngine.js');
const { Scene } = await import('@babylonjs/core/scene.js');
const { Color3 } = await import('@babylonjs/core/Maths/math.color.js');

const engine = new NullEngine();
const scene = new Scene(engine);
const vehicle = vehicleModule.createVehicle({
  scene,
  terrain: { heightAt: () => 0, normalAt: () => ({ x: 0, y: 1, z: 0 }), sampleSurface: () => ({ height: 0, normal: { x: 0, y: 1, z: 0 } }) },
  spawn: { x: 0, z: 0 },
});

const brakeMeshes = vehicle.root.getChildMeshes().filter((mesh) => mesh.material?.name === 'vehicle:brake-lights');
assert.equal(brakeMeshes.length, 1, 'rear brake lamps share one material batch');
const brakeMaterial = brakeMeshes[0].material;
assert.ok(brakeMaterial && 'emissiveColor' in brakeMaterial, 'brake lamps use an emissive-capable material');
assert.ok(brakeMaterial.emissiveColor.equals(Color3.Black()), 'brake lamps start unlit');

vehicle.setInput({ throttle: 1, steer: 0, handbrake: false, neutral: false });
for (let i = 0; i < 20; i++) vehicle.step(1 / 60);
vehicle.setInput({ throttle: -1, steer: 0, handbrake: false, neutral: false });
vehicle.step(1 / 60);
assert.ok(brakeMaterial.emissiveColor.r > brakeMaterial.emissiveColor.g, 'forward braking lights the rear lamps red');

vehicle.setInput({ throttle: 0, steer: 0, handbrake: true, neutral: false });
vehicle.step(1 / 60);
assert.ok(brakeMaterial.emissiveColor.r > 0, 'handbrake lights the rear lamps');

vehicle.setInput({ throttle: 0, steer: 0, handbrake: false, neutral: false });
vehicle.step(1 / 60);
assert.ok(brakeMaterial.emissiveColor.equals(Color3.Black()), 'released brakes turn the rear lamps off');

vehicle.dispose();
scene.dispose();
engine.dispose();
console.log('PASS brake lights: forward braking, handbrake, release, one rear-material batch');
