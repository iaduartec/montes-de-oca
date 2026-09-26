#!/usr/bin/env node
// Valida procedencia, empaquetado y solape espacial del ráster IGN MDSnE.
// La huella OSM se consulta sólo para probar la cobertura; no se escribe una
// tabla fusionada ni se asocian IDs OSM al archivo binario IGN.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const meta = JSON.parse(readFileSync(resolve(root, 'public/village/building_height_grid.json'), 'utf8'));
const manifest = JSON.parse(readFileSync(resolve(root, 'data/gameplay/raw/ign_mdsn_e025_villafranca_manifest.json'), 'utf8'));
const villageDoc = JSON.parse(readFileSync(resolve(root, 'public/village/buildings.json'), 'utf8'));
const buildings = villageDoc.buildings;
const config = JSON.parse(readFileSync(resolve(root, 'public/terrain/config.json'), 'utf8'));
const bytes = readFileSync(resolve(root, 'public/village', meta.valuesFile));
let ok = true;
function check(name, pass, detail = '') {
  console.log(`${pass ? '[OK  ]' : '[FAIL]'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!pass) ok = false;
}

check('IGN/CNIG CC BY metadata is present', meta.license === 'CC BY 4.0 (IGN/CNIG)');
check('source matches the fetch manifest', meta.sourceSha256 === manifest.source_sha256 && meta.sourceUrl === manifest.source_url);
check('raster is EPSG:25830 at 2.5 m', meta.crs === 'EPSG:25830' && meta.grid.pixel_size_m === 2.5);
check('Int16 matrix has the declared byte length', bytes.length === meta.grid.width * meta.grid.height * 2,
  `${bytes.length} bytes`);
const binaryHash = createHash('sha256').update(bytes).digest('hex');
check('runtime grid SHA-256 matches metadata', binaryHash === meta.valuesSha256, binaryHash);

const values = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
let positiveCells = 0;
let maximumM = 0;
for (let i = 0; i < bytes.length; i += 2) {
  const value = values.getInt16(i, true);
  if (value > 0) {
    positiveCells++;
    maximumM = Math.max(maximumM, value);
  }
}
check('grid has valid building heights', positiveCells > 1000 && maximumM <= 60,
  `${positiveCells} positive cells; max ${maximumM} m`);

const { width, height, pixel_size_m: pixelSize, top_left_easting_m: topLeftE, top_left_northing_m: topLeftN } = meta.grid;
const scale = config.worldScale;
const e0 = config.bounds.e[0];
const n0 = config.bounds.n[0];
function inside(points, x, z) {
  let hit = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i];
    const b = points[j];
    if ((a[1] > z) !== (b[1] > z) && x < ((b[0] - a[0]) * (z - a[1])) / (b[1] - a[1]) + a[0]) hit = !hit;
  }
  return hit;
}
function centroid(points) {
  return [points.reduce((sum, p) => sum + p[0], 0) / points.length, points.reduce((sum, p) => sum + p[1], 0) / points.length];
}

let coveredBuildings = 0;
let nearSpawnCoveredBuildings = 0;
const spawnWorld = villageDoc.meta.spawn;

for (const building of buildings) {
  const points = building.footprint;
  const easting = points.map(([x]) => e0 + x / scale);
  const northing = points.map(([, z]) => n0 + z / scale);
  const colMin = Math.max(0, Math.floor((Math.min(...easting) - topLeftE) / pixelSize));
  const colMax = Math.min(width - 1, Math.floor((Math.max(...easting) - topLeftE) / pixelSize));
  const rowMin = Math.max(0, Math.floor((topLeftN - Math.max(...northing)) / pixelSize));
  const rowMax = Math.min(height - 1, Math.floor((topLeftN - Math.min(...northing)) / pixelSize));
  let samples = 0;
  for (let row = rowMin; row <= rowMax; row++) {
    const z = (topLeftN - (row + 0.5) * pixelSize - n0) * scale;
    for (let col = colMin; col <= colMax; col++) {
      if (values.getInt16((row * width + col) * 2, true) <= 0) continue;
      const x = (topLeftE + (col + 0.5) * pixelSize - e0) * scale;
      if (inside(points, x, z)) samples++;
    }
  }
  const [cx, cz] = centroid(points);
  if (samples >= 4) {
    coveredBuildings++;
    if (Math.hypot(cx - spawnWorld.x, cz - spawnWorld.z) <= 90) nearSpawnCoveredBuildings++;
  }
}
check('raster overlaps enough OSM footprints', coveredBuildings >= 270, `${coveredBuildings}/${buildings.length} huellas con ≥4 celdas`);
check('spawn view has LiDAR height samples', nearSpawnCoveredBuildings >= 12, `${nearSpawnCoveredBuildings} huellas dentro de 90 m`);

if (!ok) process.exit(1);
