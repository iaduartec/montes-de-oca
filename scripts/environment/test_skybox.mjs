#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine.js';
import { Scene } from '@babylonjs/core/scene.js';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const temp = mkdtempSync(resolve(root, 'scripts/environment/.test-skybox-'));
try {
  const source = readFileSync(resolve(root, 'src/environment/atmosphere.ts'), 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      verbatimModuleSyntax: false,
    },
  }).outputText.replace("../runtime/quality", "./quality.mjs").replace(/(['"])(@babylonjs\/core\/[^'"]+)\1/g, '$1$2.js$1');
  writeFileSync(resolve(temp, 'quality.mjs'), ts.transpileModule(readFileSync(resolve(root, 'src/runtime/quality.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText);
  const modulePath = resolve(temp, 'atmosphere.mjs');
  writeFileSync(modulePath, output);
  const { createEnvironmentSkybox } = await import(`file://${modulePath}`);
  const engine = new NullEngine();
  const scene = new Scene(engine);
  let disposed = false;
  const environment = {
    isDisposed: false,
    dispose() { disposed = true; },
    clone() { return { coordinatesMode: 0, dispose() {} }; },
  };
  const skybox = createEnvironmentSkybox(scene, environment);

  assert.ok(skybox, 'Crea un skybox con la textura de entorno existente');
  assert.ok(skybox.material instanceof StandardMaterial, 'El cielo HDR usa el material de cubemap que recomienda Babylon');
  assert.equal(skybox.infiniteDistance, true, 'El cielo sigue a la cámara');
  assert.equal(skybox.isPickable, false, 'El cielo no intercepta interacciones');
  assert.notEqual(skybox.material?.reflectionTexture, environment, 'El material usa una copia independiente');
  skybox.dispose(false, true);
  assert.equal(disposed, false, 'Liberar el cielo conserva el HDRI del PBR');
  scene.dispose();
  engine.dispose();
  console.log('5/5 comprobaciones del skybox OK');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
