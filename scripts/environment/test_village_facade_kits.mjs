import assert from 'node:assert/strict';

let facadeKits = {};
try {
  facadeKits = await import('../../src/environment/village-facade-kits.ts');
} catch {
  // Fail below with the missing behavior instead of treating an absent module as a test error.
}

assert.equal(typeof facadeKits.selectVillageFacadeKit, 'function', 'procedural houses have a shared facade-kit selector');
assert.equal(typeof facadeKits.nearestFacadeRoutePoint, 'function', 'route-frontage selection returns the nearest route point');

const ids = Array.from({ length: 90 }, (_, index) => 4_700_000 + index * 101);
const selected = ids.map((id) => facadeKits.selectVillageFacadeKit(id));
assert.deepEqual(
  ids.map((id) => facadeKits.selectVillageFacadeKit(id)),
  selected,
  'a building keeps the same stylistic kit across loads',
);
assert.ok(new Set(selected.map((kit) => kit.id)).size >= 3, 'nearby buildings receive several facade profiles');
assert.ok(selected.every((kit) => typeof kit.tileCourses === 'boolean' && typeof kit.porton === 'boolean'), 'kits select reusable roof and entrance parts');

const footprint = [[5, -2], [10, -2], [10, 2], [5, 2]];
const onStreet = facadeKits.nearestFacadeRoutePoint(footprint, [{ x: 0, z: 0 }, { x: 20, z: 0 }]);
assert.ok(onStreet, 'route frontage is found for a neighboring footprint');
assert.ok(onStreet.distanceM <= 1e-6, `a route touching the footprint edge has zero frontage gap (${onStreet.distanceM})`);
assert.ok(Math.abs(onStreet.x - 5) <= 1, `frontage direction points toward the nearest house edge (${onStreet.x})`);

const far = facadeKits.nearestFacadeRoutePoint(footprint, [{ x: 0, z: 32 }, { x: 20, z: 32 }]);
assert.ok(far && far.distanceM > 28, 'houses outside the configured frontage radius stay unselected');

console.log('village facade kits: deterministic profiles and route frontage OK');
