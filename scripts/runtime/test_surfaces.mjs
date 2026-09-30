import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const code = ts.transpileModule(readFileSync('src/world/surfaces.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { createSurfaceResolver, SURFACES } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
const surfaceAt = createSurfaceResolver([
  { class: 'ROAD', width: 6, points: [[-50, 0], [50, 0]],
    clearance: { stepM: 100, bandLeft: [1, 1], bandRight: [3, 3] } },
  { class: 'TRACK', width: 4, points: [[0, 20], [100, 20]] },
  { class: 'PATH', width: 1, points: [[0, 40], [100, 40]] },
], (x) => x < -100 ? 'MUD' : 'GRASS');
assert.equal(surfaceAt(-32, 0).type, 'ROAD'); // negative spatial hash boundary
assert.equal(surfaceAt(0, 0.9).type, 'ROAD');
assert.equal(surfaceAt(0, 1.1).type, 'GRASS'); // asymmetric trimmed left band
assert.equal(surfaceAt(0, -2.9).type, 'ROAD');
assert.equal(surfaceAt(0, -3.1).type, 'GRASS');
assert.equal(surfaceAt(50, 21.9).type, 'TRACK');
assert.equal(surfaceAt(50, 40.4).type, 'PATH');
assert.equal(surfaceAt(50, 40.6).type, 'GRASS');
assert.equal(surfaceAt(-101, 80).type, 'MUD');
assert.equal(createSurfaceResolver([])(0, 0), SURFACES.GRASS);
assert.ok(Object.isFrozen(SURFACES.TRACK));
assert.ok(SURFACES.MUD.grip < SURFACES.GRASS.grip && SURFACES.GRASS.grip < SURFACES.ROAD.grip);
console.log('PASS surfaces: real widths, asymmetric trims, boundaries, defaults and shared immutable tuning');
