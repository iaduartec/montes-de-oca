import assert from 'node:assert/strict';
import { clampZoom, nextDrawDelay, normalizedHeading, panMapCenter, projectMapPoint } from '../../src/ui/minimap.ts';

const close = (a, b, epsilon = 1e-8) => assert.ok(Math.abs(a - b) <= epsilon, `${a} != ${b}`);

// Heading-up projection: forward (north at yaw 0, east at yaw pi/2) is top.
const north = projectMapPoint({ x: 0, z: 10 }, { x: 0, z: 0 }, 0, 1);
close(north.x, 0);
close(north.y, -10);
const east = projectMapPoint({ x: 10, z: 0 }, { x: 0, z: 0 }, Math.PI / 2, 1);
close(east.x, 0);
close(east.y, -10);

// Pan translates the viewed center opposite the dragged screen vector.
const panned = panMapCenter({ x: 0, z: 0 }, 10, 0, 0, 1);
close(panned.x, -10);
close(panned.z, 0);
close(clampZoom(0), 0.55);
close(clampZoom(500), 4);
close(normalizedHeading(null, 1.25), 1.25);
close(normalizedHeading(Number.NaN, -0.5), -0.5);
assert.equal(nextDrawDelay(50, 0), 50);
assert.equal(nextDrawDelay(100, 0), 0);
assert.equal(nextDrawDelay(50, 0, true), 0);

console.log('OK minimap: route projection, heading-up rotation, pan, zoom bounds, missing heading, 10 Hz throttle');
