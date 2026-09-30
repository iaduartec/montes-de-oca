import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';

const bundle = await build({
  entryPoints: ['src/environment/vegetation.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
});
const vegetation = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);
assert.equal(typeof vegetation.treeCanopyClearanceRadiusM, 'function', 'runtime exports its conservative crown footprint');
assert.equal(typeof vegetation.maxTreeCanopyClearanceRadiusM, 'function', 'corridor index can size itself from the loaded instances');

const expectedRadiusByType = {
  roble: 3.0,
  pino: 2.1,
  abedul: 1.7,
  haya: 2.65,
};
const maxRawScale = 1.4;
for (const [type, sourceRadius] of Object.entries(expectedRadiusByType)) {
  const clearance = vegetation.treeCanopyClearanceRadiusM(type, maxRawScale);
  assert.ok(clearance >= sourceRadius * maxRawScale * 1.24, `${type} includes the widest per-tree profile`);
  assert.ok(clearance > sourceRadius * maxRawScale, `${type} includes the crown's lobed silhouette`);
}

const data = JSON.parse(readFileSync('public/vegetation/vegetation.json', 'utf8'));
const indexedRadius = vegetation.maxTreeCanopyClearanceRadiusM(data.instances);
const largestTreeRadius = Math.max(...Object.entries(expectedRadiusByType).map(([type, radius]) =>
  data.instances
    .filter((item) => item.type === type)
    .reduce((max, item) => Math.max(max, vegetation.treeCanopyClearanceRadiusM(type, item.scale)), 0),
));
assert.ok(indexedRadius >= largestTreeRadius, 'corridor grid padding covers the largest actual tree instance');
assert.ok(indexedRadius > 4.2, 'corridor grid padding includes profile and lobe expansion beyond the old 4.2 m pad');
console.log(`PASS canopy clearance: profile/lobes/tilt covered; current maximum footprint ${indexedRadius.toFixed(2)} m`);
