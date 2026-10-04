import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine.js';
import { UniversalCamera } from '@babylonjs/core/Cameras/universalCamera.js';
import { Scene } from '@babylonjs/core/scene.js';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';

const temp = mkdtempSync(resolve('scripts/terrain/.test-road-cutouts-'));
const pointInTriangle = (x, z, triangle) => {
  const [ax, az, bx, bz, cx, cz] = triangle;
  const side = (px, pz, x0, z0, x1, z1) => (x1 - x0) * (pz - z0) - (z1 - z0) * (px - x0);
  const a = side(x, z, ax, az, bx, bz), b = side(x, z, bx, bz, cx, cz), c = side(x, z, cx, cz, ax, az);
  return (a >= -1e-8 && b >= -1e-8 && c >= -1e-8) || (a <= 1e-8 && b <= 1e-8 && c <= 1e-8);
};
const meshArea = (positions, indices) => {
  let total = 0;
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i] * 3, b = indices[i + 1] * 3, c = indices[i + 2] * 3;
    total += Math.abs((positions[b] - positions[a]) * (positions[c + 2] - positions[a + 2]) - (positions[b + 2] - positions[a + 2]) * (positions[c] - positions[a])) / 2;
  }
  return total;
};

try {
  const bundled = await build({
    entryPoints: ['src/terrain.ts', 'src/terrain-road-cutouts.ts'], outdir: temp, bundle: true, packages: 'external', platform: 'node', format: 'esm', write: false,
  });
  const modulePath = resolve(temp, 'terrain.mjs');
  const terrainOutput = bundled.outputFiles.find((file) => file.path.endsWith('terrain.js'));
  const cutoutOutput = bundled.outputFiles.find((file) => file.path.endsWith('terrain-road-cutouts.js'));
  assert.ok(terrainOutput && cutoutOutput, 'terrain and cutout bundles were emitted');
  const terrainSource = Buffer.from(terrainOutput.contents).toString('utf8')
    .replace(/(['"])(@babylonjs\/core\/[^'"]+)\1/g, '$1$2.js$1');
  const cutoutPath = resolve(temp, 'terrain-road-cutouts.mjs');
  const cutoutSource = Buffer.from(cutoutOutput.contents).toString('utf8');
  writeFileSync(modulePath, terrainSource);
  writeFileSync(cutoutPath, cutoutSource);
  const terrainModule = await import(pathToFileURL(modulePath).href);
  const { createRoadCutoutIndex, cutTerrainTriangles } = await import(pathToFileURL(cutoutPath).href);

  const source = {
    positions: new Float32Array([0, 0, 0, 10, 10, 0, 0, 20, 10]),
    normals: new Float32Array([0, 1, 0, 1, 1, 0, 0, 1, 1]),
    colors: new Float32Array([0, 0, 0.5, 1, 1, 0, 0.5, 1, 0, 1, 0.5, 1]),
    uvs: new Float32Array([0, 0, 1, 0, 0, 1]),
    indices: new Uint16Array([0, 1, 2]),
  };
  const cutter = new Float32Array([2, 2, 5, 2, 2, 5]);
  const index = createRoadCutoutIndex(cutter, 2);
  assert.ok(index?.hasBounds(2, 5, 2, 5));
  const cut = cutTerrainTriangles(source, index);
  assert.ok(Math.abs(cut.stats.removedAreaM2 - 4.5) < 1e-5, `removed projected area is ${cut.stats.removedAreaM2}`);
  assert.ok(Math.abs(meshArea(cut.positions, cut.indices) - 45.5) < 1e-5, 'remaining triangle area is conserved outside the cutter');
  assert.equal(cut.stats.clippedTriangles, 1);
  assert.ok(cut.stats.addedVertices > 0);
  const degenerateIndex = createRoadCutoutIndex(new Float32Array([2, 2, 4, 4, 6, 6]), 2);
  assert.ok(degenerateIndex && !degenerateIndex.hasBounds(2, 6, 2, 6), 'zero-area cutter triangles are excluded from the spatial index');
  const unchanged = cutTerrainTriangles(source, degenerateIndex);
  assert.equal(unchanged.stats.clippedTriangles, 0, 'zero-area cutter cannot modify the DEM');
  assert.equal(unchanged.stats.addedVertices, 0, 'zero-area cutter creates no edge vertices');
  assert.equal(unchanged.stats.outputTriangles, 1, 'zero-area cutter leaves the source triangle intact');
  for (let i = 0; i < cut.indices.length; i += 3) {
    const a = cut.indices[i] * 3, b = cut.indices[i + 1] * 3, c = cut.indices[i + 2] * 3;
    const x = (cut.positions[a] + cut.positions[b] + cut.positions[c]) / 3;
    const z = (cut.positions[a + 2] + cut.positions[b + 2] + cut.positions[c + 2]) / 3;
    assert.equal(pointInTriangle(x, z, cutter), false, 'output triangle centroid lies outside road footprint');
  }
  for (let i = 0; i < cut.positions.length / 3; i++) {
    const p = i * 3, n = i * 3, c = i * 4, uv = i * 2;
    const x = cut.positions[p], z = cut.positions[p + 2];
    assert.ok(Math.abs(cut.positions[p + 1] - (x + 2 * z)) < 1e-5, 'cut edge height remains interpolated on the source plane');
    assert.ok(Math.abs(cut.normals[n] - x / 10) < 1e-5 && Math.abs(cut.normals[n + 2] - z / 10) < 1e-5, 'cut edge normals preserve source interpolation');
    assert.ok(Math.abs(cut.colors[c] - x / 10) < 1e-5 && Math.abs(cut.colors[c + 1] - z / 10) < 1e-5, 'cut edge colors preserve source interpolation');
    assert.ok(Math.abs(cut.uvs[uv] - x / 10) < 1e-5 && Math.abs(cut.uvs[uv + 1] - z / 10) < 1e-5, 'cut edge UVs preserve source interpolation');
  }

  // A station strip is two outer-quadrilateral triangles. Interior transverse
  // tessellation may split that same footprint into more triangles; the DEM
  // excision must preserve the union exactly across those collinear boundaries.
  const quad = new Float32Array([2, 1, 6, 1, 6, 4, 2, 1, 6, 4, 2, 4]);
  const splitAtTransverseStation = new Float32Array([
    2, 1, 4, 1, 4, 4, 2, 1, 4, 4, 2, 4,
    4, 1, 6, 1, 6, 4, 4, 1, 6, 4, 4, 4,
  ]);
  const quadCut = cutTerrainTriangles(source, createRoadCutoutIndex(quad, 2));
  const splitCut = cutTerrainTriangles(source, createRoadCutoutIndex(splitAtTransverseStation, 2));
  assert.ok(Math.abs(quadCut.stats.removedAreaM2 - 12) < 1e-5, 'outer station quad removes its exact projected area');
  assert.ok(Math.abs(splitCut.stats.removedAreaM2 - quadCut.stats.removedAreaM2) < 1e-5, 'collinear transverse subdivision leaves the cutout union unchanged');
  assert.ok(Math.abs(meshArea(splitCut.positions, splitCut.indices) - meshArea(quadCut.positions, quadCut.indices)) < 1e-5, 'curved/trimmed station tessellation cannot expand or shrink the clipped DEM area');

  const grid = { x0: 0, z0: 0, dx: 1, dz: 1, columns: 5, rows: 5, heights: Array(25).fill(10) };
  const config = {
    schemaVersion: 1, origin: { lon: 0, lat: 0 }, projection: { metersPerDegreeLon: 1, metersPerDegreeLat: 1 },
    crs: 'test', bounds: { e: [0, 4], n: [0, 4] }, worldScale: 1, verticalDatum: 0, viewRadius: 20,
    spawn: null, tiles: [{ id: 'fixture', url: '/fixture.json' }],
  };
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const camera = new UniversalCamera('cutout-test-camera', new Vector3(2, 8, 2), scene);
  camera.setTarget(new Vector3(2, 0, 2));
  const terrain = await terrainModule.loadTerrain(scene, config, async () => ({
    ok: true, json: async () => ({ schemaVersion: 1, id: 'fixture', grid }),
  }));
  try {
    terrain.cull(camera);
    const rawHeight = terrain.heightAt(2, 2);
    const baseMesh = terrain.meshes[0];
    const baseVertices = baseMesh.getTotalVertices();
    const baseIndices = baseMesh.getTotalIndices();
    const rectangle = new Float32Array([1.2, 1.1, 2.8, 1.1, 2.8, 2.9, 1.2, 1.1, 2.8, 2.9, 1.2, 2.9]);
    const stats = terrain.setRoadCutouts(rectangle);
    const cutMesh = terrain.meshes[0];
    const cutVertices = cutMesh.getTotalVertices();
    const cutIndices = cutMesh.getTotalIndices();
    assert.ok(stats.removedAreaM2 >= 2.8 && stats.removedAreaM2 <= 3.0, `tile cut area ${stats.removedAreaM2}`);
    assert.ok(cutVertices > baseVertices, `resident tile mesh receives boundary vertices (${baseVertices} -> ${cutVertices}; reported +${stats.addedVertices})`);
    assert.notEqual(cutIndices, baseIndices, 'resident tile indices contain the cut geometry');
    assert.equal(terrain.heightAt(2, 2), rawHeight, 'CPU DEM height remains raw');
    assert.equal(terrain.samplers[0].heightAt(2, 2), 10, 'the original heightfield sampler remains unchanged');

    camera.position.set(500, 8, 500);
    camera.setTarget(new Vector3(500, 0, 500));
    terrain.cull(camera);
    assert.equal(terrain.meshes.length, 0, 'far tile unloads its cut GPU mesh');
    camera.position.set(2, 8, 2);
    camera.setTarget(new Vector3(2, 0, 2));
    terrain.cull(camera);
    for (let i = 0; i < 10 && terrain.residencyStats().queuedTiles + terrain.residencyStats().loadingTiles > 0; i++) terrain.runDeferredTasks(100);
    terrain.cull(camera);
    const rebuiltMesh = terrain.meshes[0];
    assert.ok(rebuiltMesh, 'tile rebuild completes');
    assert.equal(rebuiltMesh.getTotalVertices(), cutVertices, 'rebuild uses the same cutout vertex layout');
    assert.equal(rebuiltMesh.getTotalIndices(), cutIndices, 'rebuild retains the cutout index layout');
    assert.equal(terrain.heightAt(2, 2), rawHeight, 'rebuild does not alter raw CPU height');

    const restored = terrain.setRoadCutouts(new Float32Array());
    assert.equal(restored.removedAreaM2, 0);
    assert.equal(terrain.meshes[0].getTotalVertices(), baseVertices, 'clearing cutouts restores the raw GPU mesh');
    assert.equal(terrain.meshes[0].getTotalIndices(), baseIndices, 'clearing cutouts restores the raw index layout');
  } finally {
    terrain.dispose();
    scene.dispose();
    engine.dispose();
  }
  console.log('PASS terrain road cutouts: area, interpolated attributes/UV, raw CPU DEM, resident update and unload/rebuild lifecycle');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
