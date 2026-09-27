// Runtime contract checks for the static terrain orthophoto integration.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const temp = resolve(here, '.terrain-orthophoto-test');
const checks = [];
async function test(name, fn) {
  try { await fn(); checks.push([name, true]); console.log(`[OK  ] ${name}`); }
  catch (error) { checks.push([name, false]); console.log(`[FAIL] ${name}: ${error.message}`); }
}
function transpile(rel, out) {
  const code = ts.transpileModule(readFileSync(resolve(root, rel), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText.replace(/(['"])(@babylonjs\/core\/[^'"]+)\1/g, '$1$2.js$1');
  writeFileSync(resolve(temp, out), code);
}
rmSync(temp, { recursive: true, force: true });
mkdirSync(temp, { recursive: true });
try {
  transpile('src/config.ts', 'config.mjs');
  transpile('src/heightfield.ts', 'heightfield.mjs');
  transpile('src/terrain-orthophoto.ts', 'terrain-orthophoto.mjs');
  transpile('src/terrain.ts', 'terrain.mjs');
  for (const file of ['terrain.mjs', 'terrain-orthophoto.mjs']) {
    const p = resolve(temp, file);
    let code = readFileSync(p, 'utf8')
      .replace(/(['"])\.\/config\1/g, '$1./config.mjs$1')
      .replace(/(['"])\.\/heightfield\1/g, '$1./heightfield.mjs$1')
      .replace(/(['"])\.\/terrain-orthophoto\1/g, '$1./terrain-orthophoto.mjs$1');
    writeFileSync(p, code);
  }
  const [{ parseTerrainConfig }, ortho, terrain] = await Promise.all([
    import(pathToFileURL(resolve(temp, 'config.mjs')).href),
    import(pathToFileURL(resolve(temp, 'terrain-orthophoto.mjs')).href),
    import(pathToFileURL(resolve(temp, 'terrain.mjs')).href),
  ]);
  const config = JSON.parse(readFileSync(resolve(root, 'public/terrain/config.json'), 'utf8'));
  const minimal = { ...config };
  delete minimal.orthophotoManifestUrl;
  await test('test_legacy_config_without_orthophoto_still_parses', () => {
    assert.equal(parseTerrainConfig(minimal).orthophotoManifestUrl, undefined);
    assert.equal(parseTerrainConfig({ ...config, orthophotoManifestUrl: ' /terrain/orthophoto.json ' }).orthophotoManifestUrl, '/terrain/orthophoto.json');
  });
  await test('test_manifest_rejects_mismatched_crs_or_bounds', () => {
    const manifest = JSON.parse(readFileSync(resolve(root, 'public/terrain/orthophoto.json'), 'utf8'));
    assert.throws(() => ortho.parseTerrainOrthophotoManifest({ ...manifest, coverage: { ...manifest.coverage, crs: 'EPSG:4326' } }, config.bounds));
    assert.throws(() => ortho.parseTerrainOrthophotoManifest({ ...manifest, coverage: { ...manifest.coverage, eMax: manifest.coverage.eMax - 1 } }, config.bounds));
  });
  await test('test_tile_uv_maps_all_four_world_edges', () => {
    const uv = ortho.terrainTileOrthophotoUV({ x0: 0, z0: 0, dx: 10, dz: 20, columns: 2, rows: 2, heights: [0, 0, 0, 0] }, { e: [0, 10], n: [0, 20] });
    assert.deepEqual(Array.from(uv), [0, 0, 1, 0, 0, 1, 1, 1]);
  });
  await test('test_bad_texture_keeps_vertex_colour_fallback', async () => {
    const sample = { x: 5, z: 5 };
    const outcomes = [];
    for (const fail of [false, true]) {
      const engine = new (await import('@babylonjs/core/Engines/nullEngine.js')).NullEngine();
      engine.getCaps = () => ({ maxTextureSize: 8192 });
      const { Scene } = await import('@babylonjs/core/scene.js');
      const scene = new Scene(engine);
      const cfg = { ...parseTerrainConfig(minimal), tiles: [{ id: 'fixture', url: '/tile.json' }], orthophotoManifestUrl: '/manifest.json' };
      const grid = { x0: 0, z0: 0, dx: 10, dz: 10, columns: 2, rows: 2, heights: [10, 20, 30, 40] };
      let textureAttempts = 0;
      const result = await terrain.loadTerrain(scene, cfg, async (url) => ({ ok: true, json: async () => url.includes('manifest') ? JSON.parse(readFileSync(resolve(root, 'public/terrain/orthophoto.json'), 'utf8')) : { schemaVersion: 1, id: 'fixture', grid } }), {
        createTexture: (_scene, _url, onLoad, onError) => { textureAttempts++; if (fail) onError(); else onLoad(); return {}; },
      });
      assert.equal(result.heightAt(sample.x, sample.z), 25 - cfg.verticalDatum);
      assert.equal(result.meshes.length, 1);
      outcomes.push({
        height: result.heightAt(sample.x, sample.z),
        meshes: result.meshes.length,
        vertices: result.meshes[0].getTotalVertices(),
        indices: result.meshes[0].getTotalIndices(),
        colors: result.meshes[0].getVerticesData('color'),
      });
      if (fail) assert.ok(textureAttempts > 0);
      if (fail) assert.ok(Array.from(outcomes.at(-1).colors).some((value) => value < 1), 'failed texture must retain height vertex colors');
      if (!fail) {
        assert.ok(Array.from(outcomes.at(-1).colors).every((value) => value === 1), 'loaded texture must use white vertex colors');
        assert.ok(result.meshes[0].material.diffuseTexture, 'loaded texture must be assigned to the shared material');
      }
      result.dispose(); scene.dispose(); engine.dispose();
    }
    assert.equal(outcomes[0].height, outcomes[1].height);
    assert.equal(outcomes[0].meshes, outcomes[1].meshes);
    assert.equal(outcomes[0].vertices, outcomes[1].vertices);
    assert.equal(outcomes[0].indices, outcomes[1].indices);
  });
  await test('test_gpu_limit_skips_texture_creation', async () => {
    const engine = new (await import('@babylonjs/core/Engines/nullEngine.js')).NullEngine();
    const { Scene } = await import('@babylonjs/core/scene.js');
    const scene = new Scene(engine);
    engine.getCaps = () => ({ maxTextureSize: 1024 });
    let attempted = false;
    await assert.doesNotReject(() => ortho.loadTerrainOrthophotoTexture(scene, '/manifest.json', { e: [0, 6000], n: [0, 6000] }, async () => ({ ok: true, json: async () => JSON.parse(readFileSync(resolve(root, 'public/terrain/orthophoto.json'), 'utf8')) }), () => { attempted = true; return {}; }));
    assert.equal(attempted, false);
    scene.dispose(); engine.dispose();
  });
} catch (error) {
  console.error(`[FAIL] test setup: ${error.stack || error}`);
  process.exitCode = 1;
} finally {
  rmSync(temp, { recursive: true, force: true });
}
const failed = checks.filter(([, ok]) => !ok);
console.log(`${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length) process.exitCode = 1;
