import assert from 'node:assert/strict';
import { radialLobeScale, radialLobeScaleAtAngle } from '../../src/environment/vegetation-profile.ts';

assert.equal(radialLobeScale(0, 0, 0.14, 4), 1, 'los ápices conservan la punta del blob');
assert.equal(radialLobeScale(1, 0, 0.14, 4), 1, 'los ápices conservan la punta del blob');
assert.ok(Math.abs(radialLobeScale(0.5, 0, 0.14, 4) - 1.14) < 1e-9, 'un ángulo cae en el lóbulo exterior');
assert.ok(Math.abs(radialLobeScale(0.5, Math.PI / 4, 0.14, 4) - 0.86) < 1e-9, 'el ángulo contiguo forma una hendidura');
assert.equal(radialLobeScale(0.5, 0, 0, 4), 1, 'un perfil sin lobulado conserva el radio base');
assert.ok(Math.abs(radialLobeScaleAtAngle(0, 0.14, 3) - 1.14) < 1e-9, 'el enebro rompe el cono con lóbulos exteriores');
assert.ok(Math.abs(radialLobeScaleAtAngle(Math.PI / 3, 0.14, 3) - 0.86) < 1e-9, 'el perfil del enebro alterna hendiduras');
assert.equal(radialLobeScaleAtAngle(0, 0, 3), 1, 'un enebro sin variación conserva su radio');

console.log('vegetation profile: 8/8 checks OK');
