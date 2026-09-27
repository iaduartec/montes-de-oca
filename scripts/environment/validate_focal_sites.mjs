#!/usr/bin/env node
// Comprueba procedencia y límites de los assets singulares del pueblo.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const source = JSON.parse(readFileSync(resolve(root, 'assets/environment/focal-sites/sites.json'), 'utf8'));
const roads = JSON.parse(readFileSync(resolve(root, 'public/roads/roads.json'), 'utf8')).roads;
const buildings = JSON.parse(readFileSync(resolve(root, 'public/village/buildings.json'), 'utf8')).buildings;
assert.equal(source.sites.church.osm.id, 90614388, 'church must retain its OSM way ID');
assert.deepEqual(source.sites.plaza.osmWays.map((way) => way.id), [645040295, 741760074]);
assert.equal(source.sites.dam.osm.id, 168459142, 'dam must retain its OSM way ID');
assert.match(source.sites.church.height.source, /not a LiDAR measurement/);
assert.match(source.sites.church.reconstruction, /stylized low-poly approximation/);
assert.equal(source.sites.church.photoReference.license, 'CC BY-SA 4.0');
assert.equal(source.attribution.osm, '© OpenStreetMap contributors, ODbL 1.0');
assert.equal(source.attribution.ign, '© Instituto Geográfico Nacional (IGN/CNIG), CC BY 4.0');
assert.equal(source.sites.parking.traceStatus, 'pending manual PNOA inspection');
assert.equal(source.sites.parking.boundsWorldXZ, null, 'untraced parking geometry must not be guessed');

const plazaRoad = roads.find((road) => road.id === '741760074');
const rawOsm = JSON.parse(readFileSync(resolve(root, 'data/roads/raw/osm_highways_window.json'), 'utf8'));
const square = rawOsm.elements.find((way) => way.id === 645040295);
assert.ok(plazaRoad && square, 'plaza anchors need the existing road centerline and pedestrian polygon');
const firstRawRoadPoint = rawOsm.elements.find((way) => way.id === 741760074).geometry[0];
const firstRoadWorldPoint = plazaRoad.points[0];
const latScale = 111_132;
const lonScale = 111_320 * Math.cos(firstRawRoadPoint.lat * Math.PI / 180);
const squareWorld = square.geometry.map((point) => [
  firstRoadWorldPoint[0] + (point.lon - firstRawRoadPoint.lon) * lonScale,
  firstRoadWorldPoint[1] + (point.lat - firstRawRoadPoint.lat) * latScale,
]);
const distanceToSegment = (point, a, b) => {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const length2 = dx * dx + dz * dz;
  const t = Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dz) / (length2 || 1)));
  return Math.hypot(point[0] - a[0] - t * dx, point[1] - a[1] - t * dz);
};
const distanceToPolyline = (point, line) => Math.min(...line.slice(1).map((b, i) => distanceToSegment(point, line[i], b)));
const insidePolygon = (point, polygon) => {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i];
    const b = polygon[j];
    if (((a[1] > point[1]) !== (b[1] > point[1]))
      && point[0] < ((b[0] - a[0]) * (point[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
};
for (const [index, anchor] of source.sites.plaza.furnitureAnchorsWorldXZ.entries()) {
  assert.ok(insidePolygon(anchor, squareWorld), `plaza furniture ${index} must be inside OSM pedestrian polygon`);
  assert.ok(distanceToPolyline(anchor, plazaRoad.points) >= 5, `plaza furniture ${index} needs 5 m road clearance`);
  const nearestBuilding = Math.min(...buildings.map((building) => distanceToPolyline(anchor, [...building.footprint, building.footprint[0]])));
  assert.ok(nearestBuilding >= 3, `plaza furniture ${index} needs 3 m building-footprint clearance`);
}

const manifestPath = resolve(root, 'public/village/focal-sites/manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const runtimeLoader = readFileSync(resolve(root, 'src/environment/village-landmarks.ts'), 'utf8');
assert.match(manifest.reconstruction, /stylized approximation/);
assert.ok(manifest.assets.church && manifest.assets.plaza, 'church and plaza GLBs are required');
assert.ok(!manifest.assets.parking, 'unverified parking geometry must not be exported');
const waterDam = JSON.parse(readFileSync(resolve(root, 'public/water/water.json'), 'utf8')).dam;
assert.ok(manifest.assets.dam.crestPoints >= 3, 'dam GLB must record the curved OSM crest');
assert.equal(manifest.assets.dam.crestPoints, waterDam.crest.length, 'dam crest point count must match water.json');
assert.equal(manifest.assets.dam.yawRad, 0, 'dam is authored in anchor-local coordinates, no yaw');
let totalBytes = 0;
let totalTriangles = 0;
for (const [id, asset] of Object.entries(manifest.assets)) {
  const glbPath = resolve(root, asset.glb);
  const bytes = readFileSync(glbPath);
  assert.equal(bytes.subarray(0, 4).toString(), 'glTF', `${id}: invalid GLB header`);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), asset.sha256, `${id}: SHA-256 mismatch`);
  assert.equal(statSync(glbPath).size, asset.bytes, `${id}: byte count mismatch`);
  assert.ok(asset.triangles > 0 && asset.triangles <= 20_000, `${id}: triangle budget`);
  assert.ok(asset.meshes <= 2, `${id}: draw-call proxy exceeds two meshes`);
  const runtimeName = { church: 'iglesia', plaza: 'plaza', dam: 'presa' }[id];
  assert.match(runtimeLoader, new RegExp(`\\{ name: '${runtimeName}',[^\\n]*bytes: ${asset.bytes}\\b`), `${id}: runtime byte accounting must match exported GLB`);
  totalBytes += asset.bytes;
  totalTriangles += asset.triangles;
}
assert.ok(totalBytes <= 600 * 1024, 'focal site GLBs exceed 600 KiB');
assert.ok(totalTriangles <= 20_000, 'focal site geometry exceeds 20,000 triangles');
console.log(`OK: ${Object.keys(manifest.assets).join(', ')}; ${totalBytes} bytes; ${totalTriangles} triangles`);
