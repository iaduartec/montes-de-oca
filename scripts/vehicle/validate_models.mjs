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
// Silueta legible desde juego normal: cuñas de capó/cabina/baúl (slopedBox),
// ancho atado a tamaño y pisada (catalogBodyWidth) y guardabarros por rueda.
for (const marker of ['slopedBox', 'catalogBodyWidth', 'arch-f-', 'arch-r-', 'frontDrop']) {
  if (!model.includes(marker)) throw new Error(`Falta geometría en model.ts: ${marker}`);
}
// El selector construye cada vehículo desde el catálogo y lo cambia por el camino
// atómico (`switch`): ya no se muta la apariencia de un actor fijo en `main.ts`.
if (!integration.includes('cambiarVehiculo')) throw new Error('main.ts no cablea el cambio de vehículo');
if (!integration.includes('createVehicle(options, definition)')) {
  throw new Error('main.ts no crea actores desde el catálogo');
}
console.log('OK modelos de vehículo: tres identidades y kits intercambiables sin tocar la física');

// Exercise the actual actor and Babylon scene, including disposal. A missing
// adapter must fail before any implementation is added.
const bundle = async (entry) => (await build({
  entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', write: false,
})).outputFiles[0].contents;
const actorModule = await import(`data:text/javascript;base64,${Buffer.from(await bundle('src/vehicle/four-wheel.ts')).toString('base64')}`);
const catalogModule = await import(`data:text/javascript;base64,${Buffer.from(await bundle('src/vehicle/catalog.ts')).toString('base64')}`);
const physicsModule = await import(`data:text/javascript;base64,${Buffer.from(await bundle('src/vehicle/physics.ts')).toString('base64')}`);
const DEFAULTS = physicsModule.DEFAULT_VEHICLE_PARAMS;
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
const signatures = new Map();
const engine = new NullEngine();
const scene = new Scene(engine);
const terrain = { heightAt: () => 0, normalAt: () => ({ x: 0, y: 1, z: 0 }), sampleSurface: () => ({ height: 0, normal: { x: 0, y: 1, z: 0 } }) };
// Firma geométrica real: no depende del name, sino de la geometría fusionada
// (vértices cuantizados a 5 mm + bbox + triángulos). Reutilizar la misma caja
// con otro color da la misma firma y falla.
function geometricSignature(root) {
  const meshes = root.getChildMeshes().filter((mesh) => !mesh.name.startsWith('vehicle:wheel-') && !mesh.name.startsWith('vehicle:hub-cap-'));
  let triangles = 0;
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  let checksum = 0;
  for (const mesh of meshes) {
    const positions = mesh.getVerticesData('position') ?? [];
    const indices = mesh.getIndices() ?? [];
    triangles += indices.length / 3;
    for (let i = 0; i < positions.length; i += 3) {
      const qx = Math.round(positions[i] * 200);
      const qy = Math.round(positions[i + 1] * 200);
      const qz = Math.round(positions[i + 2] * 200);
      // Suma ponderada por posición local del mesh para captar perfil/cabina/frontal/trasera.
      const lx = Math.round(mesh.position.x * 200);
      const lz = Math.round(mesh.position.z * 200);
      checksum = (checksum + qx * 31 + qy * 131 + qz * 17 + lx * 7 + lz * 13 + i) | 0;
      const wx = positions[i] + mesh.position.x;
      const wy = positions[i + 1] + mesh.position.y;
      const wz = positions[i + 2] + mesh.position.z;
      if (wx < minX) minX = wx;
      if (wy < minY) minY = wy;
      if (wz < minZ) minZ = wz;
      if (wx > maxX) maxX = wx;
      if (wy > maxY) maxY = wy;
      if (wz > maxZ) maxZ = wz;
    }
  }
  const bbox = [minX, minY, minZ, maxX, maxY, maxZ].map((v) => v.toFixed(2)).join(',');
  return `tri=${triangles}|bbox=${bbox}|sum=${checksum}`;
}
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
  const signature = geometricSignature(vehicle.root);
  assert.ok(!signatures.has(signature), `${definition.id} silhouette collides geometrically with ${signatures.get(signature)} (same box reused?)`);
  signatures.set(signature, definition.id);
  const activeMeshes = scene.meshes.length - beforeMeshes;
  const triangles = vehicle.root.getChildMeshes().reduce((sum, mesh) => sum + (mesh.getTotalIndices() / 3), 0);
  console.log(`${definition.id}: meshes=${activeMeshes} triangles=${triangles} sig=${signature.slice(0, 80)}`);
  // Ruedas con volumen: tapacubos presentes y pisada (ancho de rueda > 0.2).
  const hubCaps = vehicle.root.getChildMeshes().filter((mesh) => mesh.name.startsWith('vehicle:hub-cap-'));
  assert.equal(hubCaps.length, 4, `${definition.id} hubcaps`);
  // Geometría atada a tamaño y pisada (bbox real de la firma):
  // la carrocería cubre el exterior del neumático sin pasarse del tamaño
  // (efecto kart), llega a los ejes y no pierde la cabina ni el techo.
  const merged = { ...DEFAULTS, ...definition.params };
  const halfTrack = merged.track / 2;
  const axle = merged.wheelBase / 2;
  const [minX, , minZ, maxX, maxY, maxZ] = signature.split('|')[1].slice(5).split(',').map(Number);
  assert.ok(maxX >= halfTrack + 0.16 - 0.03, `${definition.id} body covers outer tyre`);
  assert.ok(maxX <= definition.bodySize.widthM / 2 + 0.16, `${definition.id} width tied to size`);
  assert.ok(maxZ >= axle + merged.wheelRadius - 0.05, `${definition.id} nose reaches front axle`);
  assert.ok(minZ <= -axle, `${definition.id} tail reaches rear axle`);
  assert.ok(maxY <= definition.bodySize.heightM + 0.12, `${definition.id} height tied to size`);
  assert.ok(maxY >= definition.bodySize.heightM * 0.6, `${definition.id} cabin present`);
  // Fusión por material: sin llamadas ni triángulos de más.
  assert.ok(activeMeshes <= 16, `${definition.id} mesh budget`);
  assert.ok(triangles < 1600, `${definition.id} triangle budget`);
  vehicle.dispose();
  assert.equal(scene.meshes.length, beforeMeshes, `${definition.id} disposes meshes`);
  assert.equal(scene.materials.length, beforeMaterials, `${definition.id} disposes materials`);
}
assert.equal(silhouettes.size, 6, 'six distinct active silhouettes');
assert.equal(signatures.size, 6, 'six geometrically distinct silhouettes (profile/cabin/front/rear)');
// Explorador ya es coche: 3 todoterrenos + 3 coches en el adapter.
assert.deepEqual(
  catalogModule.VEHICLE_CATALOG.filter((entry) => entry.category !== 'moto').map((entry) => `${entry.id}:${entry.category}`).sort(),
  ['carga:todoterreno', 'estandar:todoterreno', 'explorador:coche', 'patrulla:todoterreno', 'rally:coche', 'turismo:coche'].sort(),
);
const legacy = actorModule.createVehicle({ scene, terrain, spawn: { x: 0, z: 0 } });
legacy.setAppearance('patrulla');
assert.equal(legacy.root.getChildMeshes().find((mesh) => mesh.name === 'vehicle:variant-patrulla').isEnabled(), true);
legacy.setAppearance('carga');
assert.equal(legacy.root.getChildMeshes().find((mesh) => mesh.name === 'vehicle:variant-carga').isEnabled(), true);
legacy.dispose();
scene.dispose();
engine.dispose();
console.log('PASS four-wheel adapter: six distinct active bodies, pose, drive and disposal');
