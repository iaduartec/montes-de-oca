import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine.js';
import { Scene } from '@babylonjs/core/scene.js';
import { VILLAGE_BUILDING_OVERRIDES, selectVillageBuildingOverride } from '../../src/environment/village-building-overrides.ts';
import { hipRoofHeight, triangulateCompoundRoof, triangulateGableRoof, triangulateHipRoof } from '../../src/environment/village-roof-geometry.ts';
import { selectVillageFacadeKit, VILLAGE_FACADE_KITS } from '../../src/environment/village-facade-kits.ts';

const buildings = JSON.parse(fs.readFileSync('public/village/buildings.json', 'utf8')).buildings;
const expected = [818885706, 818885708, 474364245, 474649085, 672017718];
assert.deepEqual(Object.keys(VILLAGE_BUILDING_OVERRIDES).map(Number).sort((a, b) => a - b), expected.slice().sort((a, b) => a - b));
assert.equal(selectVillageBuildingOverride(818885706).roofShape, 'gable');
assert.equal(selectVillageBuildingOverride(818885708).roofShape, 'hip');
assert.equal(selectVillageBuildingOverride(474364245).roofShape, 'hip');
assert.equal(selectVillageBuildingOverride(474649085).ridgeRadians, Math.PI / 2);
assert.equal(selectVillageBuildingOverride(672017718).roofKind, 'teja');
assert.equal(selectVillageBuildingOverride(672017718).roofShape, 'compound', 'hospital uses compound roof wings');
assert.ok(Array.isArray(selectVillageBuildingOverride(672017718).compoundWings), 'hospital defines compound wings');
assert.equal(selectVillageBuildingOverride(310174514), undefined, 'verified no-op control is not overridden');
assert.equal(selectVillageFacadeKit(1, { artistic: VILLAGE_FACADE_KITS[0] }).id, VILLAGE_FACADE_KITS[0].id);
assert.equal(selectVillageFacadeKit(1, { evidence: VILLAGE_FACADE_KITS[1], artistic: VILLAGE_FACADE_KITS[0] }).id, VILLAGE_FACADE_KITS[1].id);
assert.equal(selectVillageFacadeKit(1, { building: VILLAGE_FACADE_KITS[2], evidence: VILLAGE_FACADE_KITS[1] }).id, VILLAGE_FACADE_KITS[2].id);

const compactHip = { center: [0, 0], axis: [1, 0], halfU: 2, halfV: 2, ridgeHalfU: 0, topY: 10, drop: 2 };
assert.equal(hipRoofHeight([0, 0], compactHip), 10, 'compact hip keeps its center as the maximum');
assert.equal(hipRoofHeight([2, 0], compactHip), 8, 'compact hip descends to the end edge');
assert.equal(hipRoofHeight([0, 2], compactHip), 8, 'compact hip descends to the side edge');
const compactFootprint = [[-2, -2], [2, -2], [2, 2], [-2, 2]];
const compactTriangles = triangulateHipRoof(compactFootprint, compactHip);
let compactArea = 0, compactMaxY = -Infinity;
for (const tri of compactTriangles) {
  const [a, b, c] = tri;
  for (const vertex of [a, b, c]) {
    assert.ok(inside(compactFootprint, vertex[0], vertex[2]), 'compact hip vertices stay within the source footprint');
    compactMaxY = Math.max(compactMaxY, vertex[1]);
  }
  compactArea += Math.abs((b[0] - a[0]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[0] - a[0])) / 2;
}
assert.equal(compactMaxY, compactHip.topY, 'compact hip preserves the exact roof maximum');
assert.ok(Math.abs(compactArea - 16) < 1e-4, 'compact hip tessellation covers its footprint area exactly');

const concave = [[0, 0], [8, 0], [8, 2], [3, 2], [3, 6], [0, 6]];
const gable = triangulateGableRoof(concave, { center: [4, 3], axis: [1, 0], halfV: 3, eaveY: 4, rise: 2 });
assert.ok(gable.length > 0, 'concave gable is triangulated');
let gableArea = 0;
for (const tri of gable) {
  const [a, b, c] = tri;
  for (const p of [[a[0], a[2]], [b[0], b[2]], [c[0], c[2]], [(a[0] + b[0]) / 2, (a[2] + b[2]) / 2]]) {
    assert.ok(inside(concave, p[0], p[1]), `gable point ${p} remains in the concave footprint`);
  }
  gableArea += Math.abs((b[0] - a[0]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[0] - a[0])) / 2;
}
assert.ok(Math.abs(gableArea - Math.abs(area(concave))) < 1e-4, 'concave gable covers the footprint exactly once');

function area(p) { return p.reduce((s, a, i) => { const b = p[(i + 1) % p.length]; return s + a[0] * b[1] - b[0] * a[1]; }, 0) / 2; }
function inside(p, x, z) {
  let hit = false;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const a = p[i], b = p[j], dx = b[0] - a[0], dz = b[1] - a[1];
    const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / (dx * dx + dz * dz || 1)));
    if (Math.hypot(x - (a[0] + dx * t), z - (a[1] + dz * t)) < 1e-6) return true;
    if ((a[1] > z) !== (b[1] > z) && x < (b[0] - a[0]) * (z - a[1]) / (b[1] - a[1]) + a[0]) hit = !hit;
  }
  return hit;
}
function getHalfV(polygon) {
  const twiceArea = polygon.reduce((sum, a, i) => { const b = polygon[(i + 1) % polygon.length]; return sum + a[0] * b[1] - b[0] * a[1]; }, 0);
  let cx = 0;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i], b = polygon[(i + 1) % polygon.length], cross = a[0] * b[1] - b[0] * a[1];
    cx += (a[0] + b[0]) * cross;
  }
  cx /= 3 * twiceArea;
  return Math.max(...polygon.map(point => Math.abs(point[0] - cx)));
}
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
    for (const vertex of [a, b, c]) assert.ok(inside(points, vertex[0], vertex[2]), `${id} roof vertex is within source footprint`);
    maxY = Math.max(maxY, a[1], b[1], c[1]);
    triangleArea += Math.abs((b[0] - a[0]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[0] - a[0])) / 2;
  }
  assert.ok(Math.abs(maxY - topY) < 1e-6, `${id} keeps the existing roof maximum`);
  assert.ok(Math.abs(triangleArea - Math.abs(signed)) < 1e-4, `${id} roof tessellation preserves OSM footprint area`);
}

{
  const hospital = buildings.find(b => b.id === 672017718);
  const override = selectVillageBuildingOverride(672017718);
  assert.ok(hospital && override?.compoundWings, 'hospital building and override wings exist');
  const topY = hospital.heightM;
  const compound = triangulateCompoundRoof({
    polygon: hospital.footprint,
    wings: override.compoundWings,
    topY,
  });
  assert.ok(compound.triangles.length > 0, 'hospital generates compound triangles');
  let compoundArea = 0, compoundMaxY = -Infinity;
  for (const tri of compound.triangles) {
    const [a, b, c] = tri;
    const centroid = [(a[0] + b[0] + c[0]) / 3, (a[2] + b[2] + c[2]) / 3];
    assert.ok(inside(hospital.footprint, centroid[0], centroid[1]), 'hospital triangle centroid remains in footprint');
    for (const v of [a, b, c]) {
      assert.ok(inside(hospital.footprint, v[0], v[2]), 'hospital triangle vertex remains in footprint');
    }
    compoundMaxY = Math.max(compoundMaxY, a[1], b[1], c[1]);
    compoundArea += Math.abs((b[0] - a[0]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[0] - a[0])) / 2;
  }
  const footprintArea = Math.abs(area(hospital.footprint));
  assert.ok(Math.abs(compoundArea - footprintArea) < 1e-3, 'compound roof tessellation preserves 1259 m² area');
  assert.ok(compoundMaxY <= topY + 1e-6, 'compound roof does not exceed topY');
  assert.ok(compound.wings.some(w => w.roofKind === 'chapa'), 'compound roof contains glazing patch in chapa');
  assert.ok(compound.wings.some(w => w.roofKind === 'teja'), 'compound roof contains main wings in teja');
}

const temp = mkdtempSync(resolve('.village-nullengine-'));
const bundled = await build({ entryPoints: ['src/environment/village.ts'], bundle: true, packages: 'external', platform: 'node', format: 'esm', write: false });
const modulePath = resolve(temp, 'village.mjs');
const moduleSource = Buffer.from(bundled.outputFiles[0].contents).toString('utf8')
  .replace(/(['"])(@babylonjs\/core\/[^'"]+)\1/g, '$1$2.js$1')
  .replace(/(['"])@babylonjs\/loaders\/glTF\1/g, '$1@babylonjs/loaders/glTF/index.js$1');
writeFileSync(modulePath, moduleSource);
const { loadVillage } = await import(pathToFileURL(modulePath).href);
const originalFetch = globalThis.fetch;

async function renderFixture(building, facadeKit, detailed = false) {
  const footprint = building.footprint;
  const xs = footprint.map(point => point[0]), zs = footprint.map(point => point[1]);
  const minX = Math.min(...xs) - 10, maxX = Math.max(...xs) + 10;
  const minZ = Math.min(...zs) - 10, maxZ = Math.max(...zs) + 10;
  const fixture = { schemaVersion: 1, buildings: [{ ...building, heightSource: 'height' }] };
  globalThis.fetch = async url => {
    const path = String(url);
    if (path.includes('buildings')) return { ok: true, status: 200, json: async () => fixture };
    if (path.includes('walls')) return { ok: true, status: 200, json: async () => ({ walls: [] }) };
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const grid = { x0: minX, z0: minZ, dx: maxX - minX, dz: maxZ - minZ, columns: 2, rows: 2, heights: [5, 5, 5, 5] };
  const terrain = { samplers: [{ grid }], heightAt: () => 5 };
  const originalWarn = console.warn;
  try {
    console.warn = () => {};
    const village = await loadVillage(scene, terrain, {
      url: 'fixture://buildings', buildingHeightGridUrl: 'fixture://height-grid', mappedWallsUrl: 'fixture://walls',
      ...(detailed ? { facadeRoute: { points: [{ x: footprint[0][0], z: footprint[0][1] }], radiusM: 100 } } : {}),
      facadeKitsByBuilding: { [building.id]: { evidence: facadeKit } },
    });
    const roof = scene.meshes.find(mesh => mesh.name.startsWith(`pueblo:tejado:${building.roofKind}`));
    const roofMeshes = scene.meshes.filter(mesh => mesh.name.startsWith('pueblo:tejado:'));
    const body = scene.meshes.find(mesh => mesh.name.startsWith(`pueblo:cuerpo:${building.materialKind}`));
    const shutters = scene.meshes.find(mesh => mesh.name === 'pueblo:contraventanas');
    const result = {
      positions: roof?.getVerticesData('position') ?? [],
      indices: roof?.getIndices() ?? [],
      roofMeshes: roofMeshes.map(m => ({
        name: m.name,
        positions: m.getVerticesData('position') ?? [],
        indices: m.getIndices() ?? [],
      })),
      bodyPositions: body?.getVerticesData('position') ?? [],
      shutterVertices: shutters?.getTotalVertices() ?? 0,
      stats: village.stats,
    };
    village.dispose();
    return result;
  } finally {
    scene.dispose();
    engine.dispose();
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
  }
}

try {
  const targetIds = [818885706, 474649085];
  for (const id of targetIds) {
    const building = buildings.find(item => item.id === id);
    assert.ok(building, `runtime fixture exists for ${id}`);
    const scene = await renderFixture(building, VILLAGE_FACADE_KITS[2]);
    const roofVertices = scene.positions.length / 3;
    assert.ok(roofVertices > 0, `${id} creates actual Babylon roof vertices`);
    const peakOffset = id === 474649085 ? Math.min(Math.max(0.5 * getHalfV(building.footprint), 0.4), 3) : 0;
    const targetHeight = 5 + building.heightM + peakOffset;
    const maxY = Math.max(...Array.from({ length: roofVertices }, (_, i) => scene.positions[i * 3 + 1]));
    assert.ok(Math.abs(maxY - targetHeight) < 1e-4, `${id} preserves its prior maximum roof datum`);
    const bodyPoints = new Set();
    for (let i = 0; i < scene.bodyPositions.length; i += 3) bodyPoints.add(`${scene.bodyPositions[i].toFixed(5)}|${scene.bodyPositions[i + 1].toFixed(5)}|${scene.bodyPositions[i + 2].toFixed(5)}`);
    let meshArea = 0;
    for (let i = 0; i < scene.indices.length; i += 3) {
      const coords = [0, 1, 2].map(k => {
        const index = scene.indices[i + k] * 3;
        return [scene.positions[index], scene.positions[index + 1], scene.positions[index + 2]];
      });
      const [a, b, c] = coords;
      const centroid = [(a[0] + b[0] + c[0]) / 3, (a[2] + b[2] + c[2]) / 3];
      assert.ok(inside(building.footprint, centroid[0], centroid[1]), `${id} rendered roof triangle stays in its footprint`);
      meshArea += Math.abs((b[0] - a[0]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[0] - a[0])) / 2;
      for (const [x, y, z] of coords) {
        if (building.footprint.some((p, j) => {
          const q = building.footprint[(j + 1) % building.footprint.length], dx = q[0] - p[0], dz = q[1] - p[1];
          const t = Math.max(0, Math.min(1, ((x - p[0]) * dx + (z - p[1]) * dz) / (dx * dx + dz * dz || 1)));
          return Math.hypot(x - p[0] - dx * t, z - p[1] - dz * t) < 1e-5;
        })) assert.ok(bodyPoints.has(`${x.toFixed(5)}|${y.toFixed(5)}|${z.toFixed(5)}`), `${id} roof boundary vertex joins the wall top`);
      }
    }
    assert.ok(Math.abs(meshArea - Math.abs(area(building.footprint))) < 1e-3, `${id} rendered roof area equals footprint area`);
  }
  const hospital = buildings.find(item => item.id === 672017718);
  assert.ok(hospital, 'runtime fixture exists for 672017718');
  const hospitalScene = await renderFixture(hospital, VILLAGE_FACADE_KITS[2]);
  const tejaMesh = hospitalScene.roofMeshes.find(m => m.name.includes(':teja'));
  const chapaMesh = hospitalScene.roofMeshes.find(m => m.name.includes(':chapa'));
  assert.ok(tejaMesh && tejaMesh.positions.length > 0, '672017718 renders teja roof mesh');
  assert.ok(chapaMesh && chapaMesh.positions.length > 0, '672017718 renders chapa glazing mesh');
  const hospitalBodyPoints = new Set();
  for (let i = 0; i < hospitalScene.bodyPositions.length; i += 3) {
    hospitalBodyPoints.add(`${hospitalScene.bodyPositions[i].toFixed(5)}|${hospitalScene.bodyPositions[i + 1].toFixed(5)}|${hospitalScene.bodyPositions[i + 2].toFixed(5)}`);
  }
  let hospitalTotalArea = 0;
  for (const m of hospitalScene.roofMeshes) {
    for (let i = 0; i < m.indices.length; i += 3) {
      const coords = [0, 1, 2].map(k => {
        const index = m.indices[i + k] * 3;
        return [m.positions[index], m.positions[index + 1], m.positions[index + 2]];
      });
      const [a, b, c] = coords;
      const centroid = [(a[0] + b[0] + c[0]) / 3, (a[2] + b[2] + c[2]) / 3];
      assert.ok(inside(hospital.footprint, centroid[0], centroid[1]), '672017718 rendered roof triangle stays in footprint');
      hospitalTotalArea += Math.abs((b[0] - a[0]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[0] - a[0])) / 2;
      for (const [x, y, z] of coords) {
        if (hospital.footprint.some((p, j) => {
          const q = hospital.footprint[(j + 1) % hospital.footprint.length], dx = q[0] - p[0], dz = q[1] - p[1];
          const t = Math.max(0, Math.min(1, ((x - p[0]) * dx + (z - p[1]) * dz) / (dx * dx + dz * dz || 1)));
          return Math.hypot(x - p[0] - dx * t, z - p[1] - dz * t) < 1e-5;
        })) {
          assert.ok(hospitalBodyPoints.has(`${x.toFixed(5)}|${y.toFixed(5)}|${z.toFixed(5)}`), '672017718 roof boundary vertex joins the wall top');
        }
      }
    }
  }
  assert.ok(Math.abs(hospitalTotalArea - Math.abs(area(hospital.footprint))) < 1e-3, '672017718 rendered roof area equals footprint area');
  const building = buildings.find(item => item.id === 818885706);
  const styleWithShutters = await renderFixture(building, VILLAGE_FACADE_KITS[0], true);
  const styleWithoutShutters = await renderFixture(building, VILLAGE_FACADE_KITS[2], true);
  assert.ok(styleWithShutters.shutterVertices > styleWithoutShutters.shutterVertices, 'runtime consumes facade kit shutter selection');
} finally {
  rmSync(temp, { recursive: true, force: true });
}

console.log('village building overrides: source targets and concave hip geometry OK');
