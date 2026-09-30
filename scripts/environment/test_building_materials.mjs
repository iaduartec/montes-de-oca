import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine.js';
import { Scene } from '@babylonjs/core/scene.js';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial.js';

const temp = mkdtempSync(resolve('scripts/environment/.test-building-materials-'));
const engine = new NullEngine();
const scene = new Scene(engine);

try {
  const bundled = await build({
    entryPoints: ['src/environment/village.ts'],
    bundle: true,
    packages: 'external',
    platform: 'node',
    format: 'esm',
    write: false,
  });
  const modulePath = resolve(temp, 'village.mjs');
  const moduleSource = Buffer.from(bundled.outputFiles[0].contents).toString('utf8')
    .replace(/(['"])(@babylonjs\/core\/[^'"]+)\1/g, '$1$2.js$1')
    .replace(/(['"])@babylonjs\/loaders\/glTF\1/g, '$1@babylonjs/loaders/glTF/index.js$1');
  writeFileSync(modulePath, moduleSource);
  const villageModule = await import(pathToFileURL(modulePath).href);
  const material = villageModule.createMaterial(scene, {
    name: 'test:revoco',
    diffuse: [0.8, 0.6, 0.4],
    roughness: 0.96,
  });

  assert.ok(material instanceof PBRMaterial, 'village surfaces use a PBR material');
  assert.equal(material.metallic, 0, 'plaster and masonry stay dielectric');
  assert.equal(material.roughness, 0.96, 'surface keeps its authored roughness');
  assert.equal(material.backFaceCulling, false, 'facades keep both winding directions visible');
  assert.deepEqual(
    [material.albedoColor.r, material.albedoColor.g, material.albedoColor.b],
    [0.52, 0.39, 0.26],
    'albedo is exposure-calibrated for the outdoor IBL',
  );
  material.dispose();
  console.log('building surface materials: 5/5 checks OK');
} finally {
  scene.dispose();
  engine.dispose();
  rmSync(temp, { recursive: true, force: true });
}
