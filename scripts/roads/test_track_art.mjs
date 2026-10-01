import assert from 'node:assert/strict';
import { roadVertexHue, roadVertexShade } from '../../src/road-visuals.ts';

const baseShade = (x, z) => {
  const broad = Math.sin(x * 0.043 + z * 0.061) * Math.cos(z * 0.037 - x * 0.052);
  const middle = Math.sin(x * 0.19 + z * 0.31) * Math.cos(z * 0.27 - x * 0.23);
  const fine = Math.sin(x * 0.53 - z * 0.41) * Math.cos(z * 0.47 + x * 0.37);
  return 0.68 + 0.42 * (0.5 + 0.5 * (broad * 0.45 + middle * 0.35 + fine * 0.2));
};

let trackMin = Infinity;
let trackMax = -Infinity;
let pathMin = Infinity;
let pathMax = -Infinity;
let trackMarked = 0;
let pathMarked = 0;
let samples = 0;
let hueMin = Infinity;
let hueMax = -Infinity;
for (let x = -600; x <= 600; x += 3) {
  for (let z = -600; z <= 600; z += 3) {
    const track = roadVertexShade('TRACK', x, z);
    const path = roadVertexShade('PATH', x, z);
    trackMin = Math.min(trackMin, track);
    trackMax = Math.max(trackMax, track);
    pathMin = Math.min(pathMin, path);
    pathMax = Math.max(pathMax, path);
    if (track / baseShade(x, z) < 0.995) trackMarked++;
    const pathBase = 0.84 + 0.16 * (0.5 + 0.5 * (
      Math.sin(x * 0.043 + z * 0.061) * Math.cos(z * 0.037 - x * 0.052) * 0.45 +
      Math.sin(x * 0.19 + z * 0.31) * Math.cos(z * 0.27 - x * 0.23) * 0.35 +
      Math.sin(x * 0.53 - z * 0.41) * Math.cos(z * 0.47 + x * 0.37) * 0.2
    ));
    if (path / pathBase < 0.995) pathMarked++;
    samples++;
    for (const value of roadVertexHue('TRACK', x, z)) {
      hueMin = Math.min(hueMin, value);
      hueMax = Math.max(hueMax, value);
    }
  }
}

assert.ok(trackMin >= 0.53 && trackMax <= 1.11, `TRACK shade stays bounded: ${trackMin}..${trackMax}`);
assert.ok(pathMin >= 0.78 && pathMax <= 1.01, `PATH variation stays subtle: ${pathMin}..${pathMax}`);
assert.ok(trackMarked / samples > 0.005 && trackMarked / samples < 0.1,
  `darker TRACK marks stay localized (${(100 * trackMarked / samples).toFixed(2)}% of sample grid)`);
assert.ok(pathMarked / samples < 0.1, 'PATH darkening remains sparse and lower contrast');
assert.ok(hueMin >= 0.91 && hueMax <= 1.09, `gravel chroma stays restrained: ${hueMin}..${hueMax}`);

// Artistic surface changes must never tint or shade mapped asphalt.
for (let x = -600; x <= 600; x += 19) {
  for (let z = -600; z <= 600; z += 23) {
    assert.equal(roadVertexShade('ROAD', x, z), 0.2 + 0.04 * (0.5 + 0.5 * (
      Math.sin(x * 0.043 + z * 0.061) * Math.cos(z * 0.037 - x * 0.052) * 0.45 +
      Math.sin(x * 0.19 + z * 0.31) * Math.cos(z * 0.27 - x * 0.23) * 0.35 +
      Math.sin(x * 0.53 - z * 0.41) * Math.cos(z * 0.47 + x * 0.37) * 0.2
    )), 'ROAD shade stays on its established palette');
    assert.deepEqual(roadVertexHue('ROAD', x, z), [1, 1, 1], 'ROAD hue stays neutral');
  }
}

console.log(`PASS track art bounds: TRACK ${trackMin.toFixed(3)}..${trackMax.toFixed(3)}, PATH ${pathMin.toFixed(3)}..${pathMax.toFixed(3)}, damp marks ${(100 * trackMarked / samples).toFixed(2)}%`);
