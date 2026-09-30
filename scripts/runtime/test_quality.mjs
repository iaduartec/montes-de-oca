import assert from 'node:assert/strict';
import { build } from 'esbuild';

const output = await build({
  entryPoints: ['src/runtime/quality.ts'], bundle: true, platform: 'node', format: 'esm', write: false,
});
const moduleUrl = `data:text/javascript;base64,${Buffer.from(output.outputFiles[0].contents).toString('base64')}`;
const quality = await import(moduleUrl);
const { GRAPHICS_QUALITY_PRESETS, DEFAULT_GRAPHICS_QUALITY, getGraphicsQualityPreset } = quality;

assert.deepEqual(Object.keys(GRAPHICS_QUALITY_PRESETS), ['LOW', 'MEDIUM', 'HIGH', 'ULTRA']);
assert.equal(DEFAULT_GRAPHICS_QUALITY, GRAPHICS_QUALITY_PRESETS.HIGH);
assert.equal(getGraphicsQualityPreset(undefined), DEFAULT_GRAPHICS_QUALITY);
assert.equal(getGraphicsQualityPreset('bad-value'), DEFAULT_GRAPHICS_QUALITY);
assert.equal(getGraphicsQualityPreset(' ultra '), GRAPHICS_QUALITY_PRESETS.ULTRA);

const low = GRAPHICS_QUALITY_PRESETS.LOW;
const medium = GRAPHICS_QUALITY_PRESETS.MEDIUM;
const high = GRAPHICS_QUALITY_PRESETS.HIGH;
const ultra = GRAPHICS_QUALITY_PRESETS.ULTRA;
assert.deepEqual(high.vegetationRadii, {
  arbol: [110, 320, 900], arbusto: [90, 250, 500], hierba: [45, 120, 220],
}, 'HIGH preserves current vegetation LOD radii');
assert.equal(high.shadowMapSize, 1024);
assert.equal(high.shadowRadiusM, 100);
assert.equal(high.renderScale, 1);

for (const key of ['shadowMapSize', 'shadowRadiusM', 'renderScale']) {
  assert.ok(low[key] < medium[key] && medium[key] < high[key] && high[key] <= ultra[key], `${key} increases across quality profiles`);
}
for (const profile of Object.values(GRAPHICS_QUALITY_PRESETS)) {
  assert.ok(profile.shadowRadiusM >= 81, `${profile.id} shadow radius keeps the player inside the documented vertical offset envelope`);
}
for (const family of ['arbol', 'arbusto', 'hierba']) {
  for (let band = 0; band < 3; band++) {
    assert.ok(low.vegetationRadii[family][band] < medium.vegetationRadii[family][band], `${family} LOW < MEDIUM band ${band}`);
    assert.ok(medium.vegetationRadii[family][band] < high.vegetationRadii[family][band], `${family} MEDIUM < HIGH band ${band}`);
    assert.equal(ultra.vegetationRadii[family][band], high.vegetationRadii[family][band], `ULTRA leaves ${family} vegetation at HIGH`);
  }
}

console.log('PASS graphics quality profiles: defaults, HIGH compatibility, monotonic budgets');
