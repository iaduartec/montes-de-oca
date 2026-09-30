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
assert.match(source.sites.church.roofEvidence.visibleFeature, /crossed/i);
assert.match(source.sites.church.towerHeightNote, /approximate/i);
assert.match(source.sites.church.towerHeightNote, /no verified vertical measurement/i);
assert.match(source.sites.church.towerHeightNote, /22 m model silhouette/i);
assert.equal(source.sites.church.userPhotoReference.author, null, 'user photo author must remain unknown');
assert.equal(source.sites.church.userPhotoReference.license, null, 'user photo license must remain unknown');
assert.equal(source.sites.plaza.platformEvidence.captureDate, null, 'user photo date must remain unknown');
assert.match(source.sites.plaza.pavingSource, /645040295/);
assert.match(source.sites.plaza.platformEvidence.use, /approximate/i);
assert.match(source.sites.plaza.platformEvidence.use, /not georeferenced/i);
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
const patioAnchor = source.sites.plaza.platformApproximateCenterWorldXZ;
assert.ok(insidePolygon(patioAnchor, squareWorld), 'approximate forecourt center must remain inside the OSM square');
assert.ok(distanceToPolyline(patioAnchor, plazaRoad.points) >= 5, 'approximate forecourt must clear the living_street');
const patioNearestBuilding = Math.min(...buildings.map((building) => distanceToPolyline(patioAnchor, [...building.footprint, building.footprint[0]])));
assert.ok(patioNearestBuilding >= 3, 'approximate forecourt must clear mapped building footprints');

const manifestPath = resolve(root, 'public/village/focal-sites/manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const runtimeLoader = readFileSync(resolve(root, 'src/environment/village-landmarks.ts'), 'utf8');
assert.match(manifest.reconstruction, /stylized approximation/);
assert.ok(manifest.assets.church && manifest.assets.plaza, 'church and plaza GLBs are required');
assert.match(manifest.assets.church.features.join(' '), /cross gable/i);
assert.match(manifest.assets.church.features.join(' '), /belfry/i);
assert.match(manifest.assets.church.features.join(' '), /extended tower shaft above nave ridge/i);
assert.ok(manifest.assets.church.verticalExtentM >= 21.9, 'church tower apex must remain near the photo-informed 22 m silhouette');
assert.match(manifest.assets.church.features.join(' '), /clock face high on shaft/i);
assert.match(manifest.assets.plaza.features.join(' '), /draped paving/i);
assert.match(manifest.assets.plaza.features.join(' '), /OSM-clipped perimeter/i);
assert.match(manifest.assets.plaza.features.join(' '), /ramp/i);
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
  const runtimeAsset = runtimeLoader.match(new RegExp(`\\{ name: '${runtimeName}',[^\\n]*\\}`))?.[0];
  assert.ok(runtimeAsset, `${id}: runtime asset entry must exist`);
  const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  assert.match(runtimeAsset, new RegExp(`anchorX: ${escapeRegex(asset.anchorWorldXZ[0])}(?:,|\\s)`), `${id}: runtime X anchor must match the manifest`);
  assert.match(runtimeAsset, new RegExp(`anchorZ: ${escapeRegex(asset.anchorWorldXZ[1])}(?:,|\\s)`), `${id}: runtime Z anchor must match the manifest`);
  if (asset.baseM !== undefined) {
    assert.match(runtimeAsset, new RegExp(`baseM: ${asset.baseM}(?:,|\\s)`), `${id}: runtime base elevation must match the manifest`);
  }
  totalBytes += asset.bytes;
  totalTriangles += asset.triangles;
}
assert.ok(totalBytes <= 600 * 1024, 'focal site GLBs exceed 600 KiB');
assert.ok(totalTriangles <= 20_000, 'focal site geometry exceeds 20,000 triangles');
console.log(`OK: ${Object.keys(manifest.assets).join(', ')}; ${totalBytes} bytes; ${totalTriangles} triangles`);

// Oca uses its own mapped footprint and dated reference-photo ledger.
const oca = JSON.parse(readFileSync(resolve(root, 'public/village/oca-site/manifest.json'), 'utf8'));
const ocaSource = JSON.parse(readFileSync(resolve(root, oca.source), 'utf8'));
assert.equal(oca.crs, 'EPSG:25830');
assert.equal(ocaSource.osm.wayId, 216539679);
assert.equal(ocaSource.campa.flightDate, null, 'unknown flight date must remain explicit');
assert.ok(ocaSource.photographs.every(photo => photo.author === 'Jialxv' && photo.license === 'CC BY-SA 4.0' && photo.capturedAt.startsWith('2017-10-04')));
for (const [id, asset] of Object.entries(oca.assets)) {
  const data = readFileSync(resolve(root, asset.glb));
  assert.equal(data.readUInt32LE(0), 0x46546c67, `${id}: valid GLB`);
  assert.equal(data.byteLength, asset.bytes);
  assert.equal(createHash('sha256').update(data).digest('hex'), asset.sha256);
  assert.ok(asset.triangles > 0 && asset.triangles <= 3000);
  const escapedFile = id === 'ermita' ? 'ermita.glb' : 'campa.glb';
  const loaderLine = runtimeLoader.split('\n').find(line => line.includes(`../oca-site/${escapedFile}`));
  assert.ok(loaderLine, `${id}: runtime asset exists`);
  for (const [label, value] of [['anchorX',asset.anchor.x],['anchorZ',asset.anchor.z],['bytes',asset.bytes],['baseM',asset.baseM]]) {
    assert.ok(loaderLine.includes(`${label}: ${value}`), `${id}: ${label} matches manifest`);
  }
  totalBytes += asset.bytes;
  totalTriangles += asset.triangles;
}
assert.ok(totalBytes <= 600 * 1024, 'all site GLBs including Oca exceed 600 KiB');
assert.ok(totalTriangles <= 20_000, 'all site GLBs including Oca exceed geometry budget');
console.log(`OK: including Oca ${totalBytes} bytes, ${totalTriangles} triangles`);
