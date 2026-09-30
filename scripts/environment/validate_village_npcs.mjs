import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { VILLAGE_NPC_SPAWNS } from '../../src/environment/village-npc-data.ts';

const roads = JSON.parse(readFileSync('public/roads/roads.json', 'utf8')).roads;
const buildings = JSON.parse(readFileSync('public/village/buildings.json', 'utf8')).buildings;

function pointSegmentDistance(point, a, b) {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const lengthSquared = dx * dx + dz * dz;
  const t = lengthSquared > 0
    ? Math.max(0, Math.min(1, ((point.x - a[0]) * dx + (point.z - a[1]) * dz) / lengthSquared))
    : 0;
  return Math.hypot(point.x - a[0] - dx * t, point.z - a[1] - dz * t);
}

function pointInPolygon(point, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, zi] = polygon[i];
    const [xj, zj] = polygon[j];
    if ((zi > point.z) !== (zj > point.z) && point.x < ((xj - xi) * (point.z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

function polygonDistance(point, polygon) {
  if (pointInPolygon(point, polygon)) return 0;
  return Math.min(...polygon.map((a, i) => pointSegmentDistance(point, a, polygon[(i + 1) % polygon.length])));
}

assert.equal(VILLAGE_NPC_SPAWNS.length, 2, 'dos peatones en el piloto');
for (const npc of VILLAGE_NPC_SPAWNS) {
  const nearbyPlazaRoad = roads
    .filter((road) => road.class === 'ROAD' && road.name === 'La Plaza')
    .flatMap((road) => road.points.slice(1).map((point, i) => ({ road, a: road.points[i], b: point })))
    .map(({ road, a, b }) => ({ road, distance: pointSegmentDistance(npc, a, b) - road.width / 2 }))
    .sort((a, b) => Math.abs(a.distance) - Math.abs(b.distance))[0];
  assert.ok(nearbyPlazaRoad && nearbyPlazaRoad.distance >= 0.5 && nearbyPlazaRoad.distance <= 1.5, `${npc.name} sits just outside La Plaza road`);
  const buildingClearance = Math.min(...buildings.map((building) => polygonDistance(npc, building.footprint)));
  assert.ok(buildingClearance >= 2, `${npc.name} clears nearby building footprints by ${buildingClearance.toFixed(2)} m`);
}

const asset = 'public/characters/field-player.glb';
assert.ok(statSync(asset).size > 100_000, 'NPCs reuse the checked-in animated human GLB');
assert.match(readFileSync('assets/characters/kenney-animated-characters-3/source/License.txt', 'utf8'), /Creative Commons Zero, CC0/);
assert.match(readFileSync('src/environment/village-npcs.ts', 'utf8'), /includes\('idle'\)/i, 'each NPC starts the authored idle clip');
console.log('village NPC placement and asset: 8/8 checks OK');
