import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine.js';
import { Scene } from '@babylonjs/core/scene.js';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial.js';

const temp = mkdtempSync(resolve('scripts/roads/.test-road-material-'));
const engine = new NullEngine();
const scene = new Scene(engine);
const terrain = { heightAt: () => 0, normalAt: (_x, _z, out) => out?.set(0, 1, 0) ?? { x: 0, y: 1, z: 0 } };
const roads = {
  roads: [
    { id: 'test-road', class: 'ROAD', width: 6, bridge: false, points: [[0, 0], [20, 0]] },
    { id: 'test-track', class: 'TRACK', width: 4, bridge: false, points: [[0, 20], [120, 20]] },
    { id: 'test-path', class: 'PATH', width: 2, bridge: false, points: [[0, 40], [20, 40]] },
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
  for (const name of ['road:asfalto', 'road:tierra', 'road:senda']) {
    const material = scene.materials.find((candidate) => candidate.name === name);
    assert.ok(material instanceof PBRMaterial, `${name} uses PBR lighting`);
    assert.ok(result.meshes.some((mesh) => mesh.material === material && mesh.useVertexColors), `${name} keeps vertex-color variation`);
    assert.equal(material.metallic, 0, `${name} stays non-metallic`);
    assert.ok(material.roughness >= 0.9, `${name} stays matte`);
  }
  assert.equal(result.meshes.length, 3, 'PBR does not split the three batched road-class meshes');
  assert.ok(result.meshes.every((mesh) => mesh.receiveShadows), 'road surfaces receive actor shadows for grounding');
  const trackMesh = result.meshes.find((mesh) => mesh.name === 'vias:TRACK');
  const trackColors = Array.from(trackMesh?.getVerticesData('color') ?? []);
  const trackRed = trackColors.filter((_, index) => index % 4 === 0);
  const trackRange = Math.max(...trackRed) - Math.min(...trackRed);
  assert.ok(trackRange >= 0.18, `TRACK has visible multiscale dirt variation in its existing vertex colors (range=${trackRange.toFixed(3)})`);
  assert.ok(trackRed[2] > trackRed[1] + 0.08, 'TRACK has two darker wheel-rut bands around a lighter center ridge');
  result.dispose();
  console.log('road surface materials: 13/13 checks OK');
} finally {
  scene.dispose();
  engine.dispose();
  rmSync(temp, { recursive: true, force: true });
}
