import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine.js';
import { Scene } from '@babylonjs/core/scene.js';
import { UniversalCamera } from '@babylonjs/core/Cameras/universalCamera.js';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { CreateGround } from '@babylonjs/core/Meshes/Builders/groundBuilder.js';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const temp = mkdtempSync(resolve(root, 'scripts/terrain/.test-tiles-runtime-'));
const source = readFileSync(resolve(root, 'src/terrain-3d-tiles.ts'), 'utf8');
const output = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
writeFileSync(resolve(temp, 'terrain-3d-tiles.mjs'), output);
let runtime;
try {
  runtime = await import(pathToFileURL(resolve(temp, 'terrain-3d-tiles.mjs')).href);
} finally {
  rmSync(temp, { recursive: true, force: true });
}

function makeScene(rightHanded = true) {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  scene.useRightHandedSystem = rightHanded;
  const camera = new UniversalCamera('tiles-test-camera', new Vector3(0, 20, -40), scene);
  camera.setTarget(Vector3.Zero());
  scene.activeCamera = camera;
  return { engine, scene, camera };
}

function makeRenderer(scene) {
  const group = new TransformNode('tiles-test-group', scene);
  const activeTiles = new Set([{ content: { uri: 'tiles/tile_1_2.glb' } }]);
  const visibleTiles = new Set([{ content: { uri: 'tiles/tile_1_2.glb' } }]);
  const listeners = new Map();
  const renderer = {
    group,
    activeTiles,
    visibleTiles,
    updateCount: 0,
    disposed: false,
    update() { this.updateCount++; },
    dispose() { this.disposed = true; },
    addEventListener(name, callback) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(callback);
    },
    removeEventListener(name, callback) { listeners.get(name)?.delete(callback); },
    emit(name, event) { for (const callback of listeners.get(name) ?? []) callback(event); },
    listenerCount() { return [...listeners.values()].reduce((sum, values) => sum + values.size, 0); },
  };
  return renderer;
}

function create(scene, camera, renderer, onError = () => {}) {
  return runtime.createTerrain3DTiles(scene, camera, {
    rendererFactory: (url, targetScene) => {
      assert.equal(url, '/terrain/3d-tiles/tileset.json');
      assert.equal(targetScene, scene);
      return renderer;
    },
    onError,
  });
}

{
  const { engine, scene, camera } = makeScene();
  const errors = [];
  const layer = runtime.createTerrain3DTiles(scene, camera, {
    rendererFactory: () => { throw new Error('tileset unavailable'); },
    onError: (error) => errors.push(error),
  });
  assert.equal(layer.state().status, 'error');
  assert.equal(layer.stats().visibleTiles, 0);
  assert.match(errors[0].message, /tileset unavailable/);
  scene.dispose(); engine.dispose();
}

{
  const { engine, scene, camera } = makeScene(false);
  assert.throws(() => create(scene, camera, makeRenderer(scene)), /right-handed/i);
  scene.dispose(); engine.dispose();
}
{
  const { engine, scene } = makeScene();
  const otherCamera = new UniversalCamera('other-camera', new Vector3(0, 10, -20), scene);
  assert.throws(() => create(scene, otherCamera, makeRenderer(scene)), /active camera/i);
  scene.dispose(); engine.dispose();
}
{
  const { engine, scene, camera } = makeScene();
  const renderer = makeRenderer(scene);
  create(scene, camera, renderer);
  scene.render(); scene.render(); scene.render();
  assert.equal(renderer.updateCount, 3, 'renderer updates exactly once per rendered frame');
  scene.dispose(); engine.dispose();
}
{
  const { engine, scene, camera } = makeScene();
  const renderer = makeRenderer(scene);
  const fallback = CreateGround('fallback-terrain', { width: 20, height: 20, subdivisions: 2 }, scene);
  const errors = [];
  const layer = create(scene, camera, renderer, (error) => errors.push(error));
  renderer.emit('load-error', {
    tile: { content: { uri: 'tiles/tile_2_3.glb' } },
    error: new Error('HTTP 404'),
    url: '/terrain/3d-tiles/tiles/tile_2_3.glb',
  });
  assert.equal(layer.state().status, 'error');
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /tiles\/tile_2_3\.glb/);
  assert.match(errors[0].url, /tile_2_3\.glb/);
  assert.equal(fallback.isEnabled(), true, 'failed tile does not disable the fallback terrain');
  scene.dispose(); engine.dispose();
}
{
  const { engine, scene, camera } = makeScene();
  const renderer = makeRenderer(scene);
  const mesh = CreateGround('loaded-tile', { width: 20, height: 20, subdivisions: 1 }, scene);
  mesh.parent = renderer.group;
  const layer = create(scene, camera, renderer);
  assert.deepEqual(layer.stats(), { visibleTiles: 1, activeTiles: 1, visibleTriangles: 2, loadedBytes: null });
  renderer.emit('load-model', { tile: { content: { uri: 'tiles/overview.glb' } }, url: '/terrain/3d-tiles/tiles/overview.glb' });
  assert.equal(layer.state().status, 'ready');
  scene.dispose(); engine.dispose();
}
{
  const { engine, scene, camera } = makeScene();
  const renderer = makeRenderer(scene);
  const layer = create(scene, camera, renderer);
  layer.dispose();
  scene.render();
  assert.equal(renderer.updateCount, 0, 'dispose removes the frame observer');
  assert.equal(renderer.listenerCount(), 0, 'dispose removes renderer listeners');
  assert.equal(renderer.disposed, true);
  assert.equal(layer.state().status, 'disposed');
  scene.dispose(); engine.dispose();
}

console.log('3D Tiles runtime adapter: 7/7 checks passed');
