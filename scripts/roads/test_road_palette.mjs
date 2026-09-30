import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine.js';
import { Scene } from '@babylonjs/core/scene.js';
import { roadVertexHue, roadVertexShade } from '../../src/road-visuals.ts';

assert.equal(roadVertexShade('ROAD', 0, 0), 0.22, 'asphalt scalar stays at its existing neutral value');
assert.equal(roadVertexShade('TRACK', 0, 0), 0.89, 'TRACK gets the stronger earth contrast range');
assert.ok(Math.abs(roadVertexShade('PATH', 0, 0) - 0.92) < 1e-12, 'PATH keeps a lighter, narrower contrast range');
assert.deepEqual(roadVertexHue('ROAD', 21, 47), [1, 1, 1], 'ROAD hue remains unchanged');
const trackHue = roadVertexHue('TRACK', 1, 2);
const pathHue = roadVertexHue('PATH', 1, 2);
assert.ok(trackHue[0] > 1 && trackHue[2] < 1, 'TRACK retains warm earth color');
assert.ok(Math.abs(pathHue[0] - 1) < Math.abs(trackHue[0] - 1), 'PATH hue is less saturated than TRACK');
for (const surface of ['ROAD', 'TRACK', 'PATH']) {
  for (const [x, z] of [[0, 0], [123.4, 56.7], [-150, 330]]) {
    assert.ok(Number.isFinite(roadVertexShade(surface, x, z)), `${surface} shade remains finite`);
    assert.ok(roadVertexHue(surface, x, z).every(Number.isFinite), `${surface} hue remains finite`);
  }
}

// Render the real road builder to ensure palette extraction changes no batching,
// vertex layout, or index topology.
const temp = mkdtempSync(resolve('scripts/roads/.test-road-palette-'));
const engine = new NullEngine();
const scene = new Scene(engine);
const terrain = { heightAt: () => 0, normalAt: (_x, _z, out) => out?.set(0, 1, 0) ?? { x: 0, y: 1, z: 0 } };
const roads = {
  roads: [
    { id: 'palette-road', class: 'ROAD', width: 6, bridge: false, points: [[0, 0], [20, 0]] },
    { id: 'palette-track', class: 'TRACK', width: 4, bridge: false, points: [[0, 20], [120, 20]] },
    { id: 'palette-path', class: 'PATH', width: 2, bridge: false, points: [[0, 40], [20, 40]] },
  ],
};

try {
  const bundled = await build({
    entryPoints: ['src/road-draping.ts'],
    bundle: true,
    packages: 'external',
    platform: 'node',
    format: 'esm',
    write: false,
  });
  const modulePath = resolve(temp, 'road-draping.mjs');
  const moduleSource = Buffer.from(bundled.outputFiles[0].contents).toString('utf8')
    .replace(/(['"])(@babylonjs\/core\/[^'"]+)\1/g, '$1$2.js$1');
  writeFileSync(modulePath, moduleSource);
  const roadModule = await import(pathToFileURL(modulePath).href);
  const result = await roadModule.loadRoadNetwork(scene, terrain, {
    fetchImpl: async () => ({ ok: true, json: async () => roads }),
  });
  assert.equal(result.meshes.length, 3, 'the three road classes remain one mesh each');
  assert.deepEqual(result.meshes.map((mesh) => mesh.name).sort(), ['vias:PATH', 'vias:ROAD', 'vias:TRACK']);
  for (const mesh of result.meshes) {
    const positions = mesh.getVerticesData('position');
    const colors = mesh.getVerticesData('color');
    const indices = mesh.getIndices();
    assert.ok(positions && colors && indices);
    assert.equal(positions.length / 3, colors.length / 4, `${mesh.name} retains one color per existing vertex`);
    assert.equal(indices.length % 3, 0, `${mesh.name} keeps triangle topology`);
  }
  const track = result.meshes.find((mesh) => mesh.name === 'vias:TRACK');
  const trackRed = Array.from(track.getVerticesData('color')).filter((_, index) => index % 4 === 0);
  assert.ok(Math.max(...trackRed) - Math.min(...trackRed) > 0.25, 'TRACK variation is visible in existing vertex colors');
  result.dispose();
  console.log('road palette and rendering invariants: OK (3 class meshes, unchanged per-vertex layout)');
} finally {
  scene.dispose();
  engine.dispose();
  rmSync(temp, { recursive: true, force: true });
}
