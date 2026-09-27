import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const presets = readFileSync('src/vehicle/presets.ts', 'utf8');
const model = readFileSync('src/vehicle/model.ts', 'utf8');
const integration = readFileSync('src/main.ts', 'utf8');
const appearances = [...presets.matchAll(/id: '([^']+)'[\s\S]*?visual: '([^']+)'/g)].map((match) => match[2]);
const expected = ['estandar', 'patrulla', 'carga'];
if (JSON.stringify(appearances) !== JSON.stringify(expected)) {
  throw new Error(`Identidades visuales de presets incorrectas: ${appearances.join(', ')}`);
}
for (const marker of [
  'setAppearance',
  "id === 'patrulla'",
  "id === 'carga'",
  'vehicle:variant-patrulla',
  'vehicle:patrol-wagon-roof',
  'vehicle:patrol-side-glass',
  'vehicle:variant-carga',
  'vehicle:cargo-bed',
]) {
  if (!model.includes(marker)) throw new Error(`Falta en model.ts: ${marker}`);
}
if (!integration.includes('vehicle.setAppearance(preset.visual)')) throw new Error('aplicarPreset no sincroniza la carrocería');
if (!/applyPreset\(vehicle\.params, preset\);\s*vehicle\.setAppearance\(preset\.visual\);/.test(integration)) {
  throw new Error('La apariencia no se aplica en el mismo flujo que la afinación física');
}
console.log('OK modelos de vehículo: tres identidades y kits intercambiables sin tocar la física');

// Exercise the actual actor and Babylon scene, including disposal. A missing
// adapter must fail before any implementation is added.
const bundle = async (entry) => (await build({
  entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', write: false,
})).outputFiles[0].contents;
const actorModule = await import(`data:text/javascript;base64,${Buffer.from(await bundle('src/vehicle/four-wheel.ts')).toString('base64')}`);
const catalogModule = await import(`data:text/javascript;base64,${Buffer.from(await bundle('src/vehicle/catalog.ts')).toString('base64')}`);
const { NullEngine } = await import('@babylonjs/core/Engines/nullEngine.js');
const { Scene } = await import('@babylonjs/core/scene.js');
const expectedParams = {
  estandar: {},
  patrulla: { mass: 1200, dragCoefficient: 0.45, maxDriveForce: 18000, maxSpeed: 38, steerRate: 8 },
  carga: { mass: 2400, dragCoefficient: 0.95, brakeForce: 16000, maxDriveForce: 10000, maxSpeed: 22, steerMax: 0.4 },
  explorador: { mass: 1550, wheelBase: 2.5 }, turismo: { mass: 1350, wheelBase: 2.68 },
  rally: { mass: 1250, wheelBase: 2.55 },
};
const silhouettes = new Set();
const engine = new NullEngine();
const scene = new Scene(engine);
const terrain = { heightAt: () => 0, normalAt: () => ({ x: 0, y: 1, z: 0 }), sampleSurface: () => ({ height: 0, normal: { x: 0, y: 1, z: 0 } }) };
for (const definition of catalogModule.VEHICLE_CATALOG.filter((entry) => entry.category !== 'moto')) {
  const beforeMeshes = scene.meshes.length;
  const beforeMaterials = scene.materials.length;
  const vehicle = actorModule.createFourWheelVehicle({ scene, terrain, spawn: { x: 0, z: 0 } }, definition);
  assert.equal(vehicle.telemetry().contacts.length, 4, `${definition.id} contacts`);
  assert.equal(vehicle.category, definition.category);
  assert.deepEqual(vehicle.bodySize, definition.bodySize);
  assert.equal(vehicle.exitOffsetM, definition.exitOffsetM);
  if (['estandar', 'patrulla', 'carga'].includes(definition.id)) {
    assert.deepEqual(definition.params, expectedParams[definition.id], `${definition.id} complete legacy preset`);
  }
  for (const [key, value] of Object.entries(expectedParams[definition.id])) assert.equal(vehicle.params[key], value, `${definition.id}.${key}`);
  assert.throws(() => vehicle.setAppearance('patrulla'), /appearance.*catalog/i, `${definition.id} rejects appearance mutation`);
  assert.equal(vehicle.contactPoints({ x: 0, z: 0, yaw: 0 }).length, 4);
  assert.ok(Number.isFinite(vehicle.applyPose()));
  vehicle.setInput({ throttle: 1, steer: 0.5, handbrake: false, neutral: false });
  vehicle.step(0.05);
  assert.ok(vehicle.telemetry().speed > 0, `${definition.id} drives`);
  assert.ok(vehicle.root.getChildTransformNodes().some((node) => node.name.includes('wheel-hub') && node.rotation.x !== 0), `${definition.id} wheel animation`);
  const body = vehicle.root.getChildMeshes().find((mesh) => mesh.name.startsWith('vehicle:body-'));
  assert.ok(body, `${definition.id} body`);
  silhouettes.add(body.name);
  const activeMeshes = scene.meshes.length - beforeMeshes;
  const triangles = vehicle.root.getChildMeshes().reduce((sum, mesh) => sum + (mesh.getTotalIndices() / 3), 0);
  console.log(`${definition.id}: meshes=${activeMeshes} triangles=${triangles}`);
  vehicle.dispose();
  assert.equal(scene.meshes.length, beforeMeshes, `${definition.id} disposes meshes`);
  assert.equal(scene.materials.length, beforeMaterials, `${definition.id} disposes materials`);
}
assert.equal(silhouettes.size, 6, 'six distinct active silhouettes');
const legacy = actorModule.createVehicle({ scene, terrain, spawn: { x: 0, z: 0 } });
legacy.setAppearance('patrulla');
assert.equal(legacy.root.getChildMeshes().find((mesh) => mesh.name === 'vehicle:variant-patrulla').isEnabled(), true);
legacy.setAppearance('carga');
assert.equal(legacy.root.getChildMeshes().find((mesh) => mesh.name === 'vehicle:variant-carga').isEnabled(), true);
legacy.dispose();
scene.dispose();
engine.dispose();
console.log('PASS four-wheel adapter: six distinct active bodies, pose, drive and disposal');
