import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../../', import.meta.url));
const bundle = await build({
  entryPoints: [`${root}src/vehicle/catalog.ts`],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
});
const { VEHICLE_CATALOG, DEFAULT_VEHICLE_ID, vehicleById } =
  await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);

const ids = VEHICLE_CATALOG.map((vehicle) => vehicle.id);
assert.equal(VEHICLE_CATALOG.length, 8);
assert.equal(new Set(ids).size, 8);
assert.deepEqual(['todoterreno', 'coche', 'moto'].map((category) =>
  VEHICLE_CATALOG.filter((vehicle) => vehicle.category === category).length), [4, 2, 2]);
assert.deepEqual(ids, ['estandar', 'patrulla', 'carga', 'explorador', 'turismo', 'rally', 'trail', 'enduro']);
assert.equal(DEFAULT_VEHICLE_ID, 'estandar');
assert.equal(vehicleById('bogus'), undefined);
for (const vehicle of VEHICLE_CATALOG) {
  assert.equal(vehicleById(vehicle.id), vehicle);
  assert.ok(vehicle.name && vehicle.summary && vehicle.visual);
  for (const dimension of ['lengthM', 'widthM', 'heightM']) {
    assert.ok(Number.isFinite(vehicle.bodySize[dimension]) && vehicle.bodySize[dimension] > 0,
      `${vehicle.id}.${dimension} must be finite and positive`);
  }
  assert.ok(Number.isFinite(vehicle.exitOffsetM) && vehicle.exitOffsetM > 0);
}
assert.deepEqual(vehicleById('estandar').params, {});
assert.deepEqual(vehicleById('patrulla').params, {
  mass: 1200, dragCoefficient: 0.45, maxDriveForce: 18000, maxSpeed: 38, steerRate: 8,
});
assert.deepEqual(vehicleById('carga').params, {
  mass: 2400, dragCoefficient: 0.95, brakeForce: 16000, maxDriveForce: 10000,
  maxSpeed: 22, steerMax: 0.4,
});
console.log('PASS vehicle catalog: eight unique entries, 4/2/2 categories, legacy values and dimensions');
