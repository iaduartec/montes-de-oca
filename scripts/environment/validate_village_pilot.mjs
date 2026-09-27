#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(new URL('../..', import.meta.url).pathname);
const manifest = JSON.parse(readFileSync(resolve(root, 'public/village/pilot-houses.json'), 'utf8'));
const buildings = JSON.parse(readFileSync(resolve(root, 'public/village/buildings.json'), 'utf8'));
const osm = JSON.parse(readFileSync(resolve(root, 'data/gameplay/raw/osm_buildings_villafranca.json'), 'utf8'));
const source = readFileSync(resolve(root, 'src/environment/village-pilot.ts'), 'utf8');
const glbPath = resolve(root, 'public/village', manifest.glb.file);
const glb = readFileSync(glbPath);
const ids = manifest.buildings.map((building) => building.osmWayId);
const styleIds = [...source.matchAll(/^\s*(\d+): \{/gm)].map((match) => Number(match[1]));
const rawIds = new Set(osm.elements.map((element) => element.id));
const processedIds = new Set(buildings.buildings.map((building) => building.id));

assert.equal(manifest.schemaVersion, 1, 'unsupported pilot manifest version');
assert.equal(ids.length, 8, 'pilot should contain 6–10 singular buildings');
assert.equal(new Set(ids).size, ids.length, 'duplicate OSM ways in pilot manifest');
assert.deepEqual([...ids].sort((a, b) => a - b), [...styleIds].sort((a, b) => a - b), 'runtime profiles and Blender manifest disagree');
assert.ok(ids.every((id) => rawIds.has(id) && processedIds.has(id)), 'pilot ID missing from versioned OSM data');
assert.ok(manifest.buildings.every((building) => building.lidarSampleCount >= 4), 'pilot house lacks sufficient LiDAR samples');
assert.ok(manifest.buildings.every((building) => building.heightSource === 'lidar'), 'pilot height did not resolve from LiDAR');
assert.ok(manifest.buildings.every((building) => building.facadeTreatment.includes('aproximada')), 'facade is not marked approximate');
assert.equal(manifest.glb.meshCount, 1, 'GLB must remain one batched mesh');
assert.ok(manifest.glb.triangles <= 3000, 'pilot exceeds triangle budget');
assert.ok(manifest.glb.bytes <= 250_000, 'pilot exceeds download budget');
assert.equal(glb.toString('ascii', 0, 4), 'glTF', 'invalid GLB magic');
assert.equal(glb.readUInt32LE(4), 2, 'expected GLB version 2');
assert.equal(glb.readUInt32LE(8), glb.length, 'GLB header length mismatch');
assert.equal(glb.length, manifest.glb.bytes, 'manifest GLB size is stale');
assert.equal(createHash('sha256').update(glb).digest('hex'), manifest.glb.sha256, 'manifest GLB hash is stale');

console.log(`[village-pilot] OK · ${ids.length} IDs OSM · ${manifest.glb.triangles} tris · ${manifest.glb.bytes} bytes · ${manifest.glb.sha256.slice(0, 12)}`);
