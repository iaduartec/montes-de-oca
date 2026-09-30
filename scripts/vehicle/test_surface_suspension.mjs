import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const runtimeDir = resolve(root, 'output/vehicle-surface-suspension-test');
await (await import('node:fs/promises')).mkdir(runtimeDir, { recursive: true });

async function loadTs(relPath) {
  const generated = join(runtimeDir, `${relPath.split('/').at(-1).replace(/\.ts$/, '')}.mjs`);
  const output = ts.transpileModule(readFileSync(resolve(root, relPath), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, verbatimModuleSyntax: false },
  }).outputText.replace(/(['"])(\.\.?\/[^'"]+)\1/g, '$1$2.mjs$1');
  writeFileSync(generated, output);
  return import(pathToFileURL(generated).href);
}

try {
const physics = await loadTs('src/vehicle/physics.ts');
const suspension = await loadTs('src/vehicle/suspension.ts');
const { createVehicleState, stepVehicleFixed, sampleContactSurfaces, DEFAULT_VEHICLE_PARAMS } = physics;
const flat = { heightAt: () => 0, normalAt: () => ({ x: 0, y: 1, z: 0 }) };
const input = { throttle: 1, steer: 0, handbrake: false, neutral: false };

// Optional material data preserves the legacy force model byte-for-byte in state.
const plainState = createVehicleState(0, 0);
const unitMaterialState = createVehicleState(0, 0);
for (let i = 0; i < 240; i++) {
  stepVehicleFixed(plainState, input, 1 / 120, DEFAULT_VEHICLE_PARAMS, flat);
  stepVehicleFixed(unitMaterialState, input, 1 / 120, DEFAULT_VEHICLE_PARAMS, {
    ...flat,
    surfaceAt: () => ({ grip: 1, lateralGrip: 1, brakingGrip: 1, rollingResistance: 1 }),
  });
}
assert.deepEqual(unitMaterialState, plainState, 'unit surface multipliers preserve legacy physics');

const lowGripState = createVehicleState(0, 0);
const highGripSurface = { ...flat, surfaceAt: () => ({ grip: 0.5, lateralGrip: 0.6, brakingGrip: 0.5, rollingResistance: 2 }) };
for (let i = 0; i < 240; i++) stepVehicleFixed(lowGripState, input, 1 / 120, DEFAULT_VEHICLE_PARAMS, highGripSurface);
assert.ok(lowGripState.speed < plainState.speed, 'low grip and higher rolling resistance reduce acceleration');
assert.ok(lowGripState.tractionLimitN < plainState.tractionLimitN, 'surface grip scales tire traction limit');

const brakeInput = { throttle: -1, steer: 0, handbrake: false, neutral: false };
const goodBrakes = createVehicleState(0, 0);
const lowBrakeGrip = createVehicleState(0, 0);
goodBrakes.speed = lowBrakeGrip.speed = 8;
stepVehicleFixed(goodBrakes, brakeInput, 1 / 120, DEFAULT_VEHICLE_PARAMS, flat);
stepVehicleFixed(lowBrakeGrip, brakeInput, 1 / 120, DEFAULT_VEHICLE_PARAMS, {
  ...flat,
  surfaceAt: () => ({ grip: 1, lateralGrip: 1, brakingGrip: 0.25, rollingResistance: 1 }),
});
assert.ok(lowBrakeGrip.speed > goodBrakes.speed, 'lower braking grip reduces brake force');

const contactState = createVehicleState(0, 0, 0);
const mixed = sampleContactSurfaces(contactState, DEFAULT_VEHICLE_PARAMS, {
  ...flat,
  surfaceAt: (_x, z) => z > 0
    ? { type: 'ROAD', grip: 1, lateralGrip: 1, brakingGrip: 1, rollingResistance: 0.5 }
    : { type: 'GRASS', grip: 0.5, lateralGrip: 0.4, brakingGrip: 0.6, rollingResistance: 2 },
});
assert.equal(mixed.grip, 0.75, 'four tire contacts average grip across a boundary');
assert.equal(mixed.lateralGrip, 0.7, 'four tire contacts average lateral grip across a boundary');
assert.equal(mixed.brakingGrip, 0.8, 'four tire contacts average braking grip across a boundary');
assert.equal(mixed.rollingResistance, 1.25, 'four tire contacts average rolling resistance across a boundary');
assert.equal(mixed.type, undefined, 'mixed contact types are not misreported as one surface');

const { createSuspensionState, stepSuspension } = suspension;
const suspensionParams = { travel: 0.24 };
const support = [2, 2, 2, 2];
const suspensionState = createSuspensionState(support, suspensionParams);
assert.equal(suspensionState.height, 2.12);
assert.deepEqual(suspensionState.compression, [0.12, 0.12, 0.12, 0.12]);

const bump = [2.18, 2, 2, 2];
stepSuspension(suspensionState, bump, [0.135, -0.045, -0.045, -0.045], 0, 0, 1 / 60, suspensionParams);
assert.ok(suspensionState.compression[0] > suspensionState.compression[1], 'raised front-left contact compresses its own spring');
assert.ok(suspensionState.height > 2.12, 'body spring responds upward to a bump');

for (let i = 0; i < 360; i++) stepSuspension(suspensionState, support, [0, 0, 0, 0], 0, 0, 1 / 120, suspensionParams);
assert.ok(Math.abs(suspensionState.height - 2.12) < 0.002, 'damped chassis settles back to ride height');
assert.ok(suspensionState.compression.every((value) => value >= 0 && value <= suspensionParams.travel), 'wheel travel stays within limits');

console.log('PASS vehicle surface multipliers and four-point damped suspension');
} finally {
  if (existsSync(runtimeDir)) rmSync(runtimeDir, { recursive: true, force: true });
}
