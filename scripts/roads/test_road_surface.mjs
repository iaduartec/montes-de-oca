import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import ts from 'typescript';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
const dest = 'src/world/road-surface.test.gen.mjs';
writeFileSync(dest, ts.transpileModule(readFileSync('src/world/road-surface.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText.replaceAll("'@babylonjs/core/Maths/math.vector'", "'@babylonjs/core/Maths/math.vector.js'"));
try {
    const { createRenderedRoadSurface } = await import('../../' + dest);
    const terrain = { heightAt: (x, z) => .1 * x + .2 * z, normalAt: (x, z, out) => (out ?? new Vector3()).set(-.1, 1, -.2).normalize() };
    const band = { class: 'ROAD', positions: [0, 2, 0, 10, 3, 0, 0, 4, 10], indices: [0, 1, 2], roles: [0, 0, 0] };
    const rendered = createRenderedRoadSurface(terrain, [band]);
    const sample = rendered.sampleAt(2, 3);
    assert.ok(Math.abs(sample.height - 2.8) < 1e-12, 'triangle barycentric height matches visible pavement');
    assert.ok(Math.abs(sample.normal.x / sample.normal.y + .08) < 1e-12, 'ROAD normal uses capped cross banking');
    assert.ok(Math.abs(sample.normal.z / sample.normal.y + .2) < 1e-12);
    const out = new Vector3();
    assert.equal(rendered.normalAt(2, 3, out), out);
    assert.equal(createRenderedRoadSurface(terrain, [{ ...band, roles: [1, 1, 1] }]).sampleAt(2, 3).skirt, true, 'skirts provide graded contact');
    assert.equal(createRenderedRoadSurface(terrain, [{ ...band, roles: [2, 2, 2] }]).sampleAt(2, 3).bridge, true);
    assert.equal(createRenderedRoadSurface(terrain, [{ ...band, roles: [4, 4, 4] }]).sampleAt(2, 3), null, 'paint excluded');
    const steep = { ...band, stations: [{ x: 0, z: 0, dx: 1, dz: 0 }, { x: 10, z: 0, dx: 1, dz: 0 }] };
    const banked = createRenderedRoadSurface(terrain, [steep]).sampleAt(2, 3);
    assert.ok(Math.abs(banked.crossSlope) <= .080001, 'ROAD driving bank is capped at 8%');
    console.log('PASS road surface: real triangle contact, skirts/paint excluded, bridge metadata');
}
finally {
    rmSync(dest, { force: true });
}
