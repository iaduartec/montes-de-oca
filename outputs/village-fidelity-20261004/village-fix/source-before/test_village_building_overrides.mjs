import assert from 'node:assert/strict';
import fs from 'node:fs';
import { VILLAGE_BUILDING_OVERRIDES, selectVillageBuildingOverride } from '../../src/environment/village-building-overrides.ts';
import { triangulateHipRoof } from '../../src/environment/village-roof-geometry.ts';
import { selectVillageFacadeKit, VILLAGE_FACADE_KITS } from '../../src/environment/village-facade-kits.ts';

const buildings = JSON.parse(fs.readFileSync('public/village/buildings.json', 'utf8')).buildings;
const expected = [818885706, 818885708, 474364245, 474649085, 672017718];
assert.deepEqual(Object.keys(VILLAGE_BUILDING_OVERRIDES).map(Number).sort((a, b) => a - b), expected.slice().sort((a, b) => a - b));
assert.equal(selectVillageBuildingOverride(818885706).roofShape, 'gable');
assert.equal(selectVillageBuildingOverride(818885708).roofShape, 'hip');
assert.equal(selectVillageBuildingOverride(474364245).roofShape, 'hip');
assert.equal(selectVillageBuildingOverride(474649085).ridgeRadians, Math.PI / 2);
assert.equal(selectVillageBuildingOverride(672017718).roofKind, 'teja');
assert.equal(selectVillageBuildingOverride(672017718).roofShape, undefined, 'hospital keeps its procedural roof volume');
assert.equal(selectVillageBuildingOverride(310174514), undefined, 'verified no-op control is not overridden');
assert.equal(selectVillageFacadeKit(1, { artistic: VILLAGE_FACADE_KITS[0] }).id, VILLAGE_FACADE_KITS[0].id);
assert.equal(selectVillageFacadeKit(1, { evidence: VILLAGE_FACADE_KITS[1], artistic: VILLAGE_FACADE_KITS[0] }).id, VILLAGE_FACADE_KITS[1].id);
assert.equal(selectVillageFacadeKit(1, { building: VILLAGE_FACADE_KITS[2], evidence: VILLAGE_FACADE_KITS[1] }).id, VILLAGE_FACADE_KITS[2].id);

const area = p => p.reduce((s, a, i) => { const b = p[(i + 1) % p.length]; return s + a[0] * b[1] - b[0] * a[1]; }, 0) / 2;
const inside = (p, x, z) => { let hit = false; for (let i = 0, j = p.length - 1; i < p.length; j = i++) { const a = p[i], b = p[j]; if ((a[1] > z) !== (b[1] > z) && x < (b[0] - a[0]) * (z - a[1]) / (b[1] - a[1]) + a[0]) hit = !hit; } return hit; };
for (const id of [818885708, 474364245]) {
  const building = buildings.find(b => b.id === id);
  assert.ok(building, `OSM footprint exists for ${id}`);
  const points = building.footprint;
  const signed = area(points);
  let cx = 0, cz = 0;
  for (let i = 0; i < points.length; i++) { const a = points[i], b = points[(i + 1) % points.length], cross = a[0] * b[1] - b[0] * a[1]; cx += (a[0] + b[0]) * cross; cz += (a[1] + b[1]) * cross; }
  const center = [cx / (6 * signed), cz / (6 * signed)];
  const cxx = points.reduce((s, p) => s + (p[0] - center[0]) ** 2, 0), czz = points.reduce((s, p) => s + (p[1] - center[1]) ** 2, 0), cxz = points.reduce((s, p) => s + (p[0] - center[0]) * (p[1] - center[1]), 0);
  const theta = 0.5 * Math.atan2(2 * cxz, cxx - czz), axis = [Math.cos(theta), Math.sin(theta)];
  let halfU = 0, halfV = 0;
  for (const p of points) { const dx = p[0] - center[0], dz = p[1] - center[1]; halfU = Math.max(halfU, Math.abs(dx * axis[0] + dz * axis[1])); halfV = Math.max(halfV, Math.abs(-dx * axis[1] + dz * axis[0])); }
  const topY = building.heightM, drop = Math.min(Math.max(0.45 * Math.min(halfU, halfV), 0.5), 2.2);
  const triangles = triangulateHipRoof(points, { center, axis, halfU, halfV, ridgeHalfU: Math.max(0, halfU - halfV), topY, drop });
  assert.ok(triangles.length > 0, `${id} creates clipped roof geometry`);
  let maxY = -Infinity, triangleArea = 0;
  for (const tri of triangles) {
    const [a, b, c] = tri;
    const x = (a[0] + b[0] + c[0]) / 3, z = (a[2] + b[2] + c[2]) / 3;
    assert.ok(inside(points, x, z), `${id} roof triangle centroid is within source footprint`);
    maxY = Math.max(maxY, a[1], b[1], c[1]);
    triangleArea += Math.abs((b[0] - a[0]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[0] - a[0])) / 2;
  }
  assert.ok(Math.abs(maxY - topY) < 1e-6, `${id} keeps the existing roof maximum`);
  assert.equal(building.heightM, buildings.find(b => b.id === id).heightM, `${id} keeps the OSM/IGN-derived building height unchanged`);
  assert.ok(Math.abs(triangleArea - Math.abs(signed)) < 1e-4, `${id} roof tessellation preserves OSM footprint area`);
}

console.log('village building overrides: source targets and concave hip geometry OK');
