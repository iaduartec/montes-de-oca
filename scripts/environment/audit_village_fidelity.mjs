#!/usr/bin/env node
// Deterministic, read-only inventory for the visible Villafranca building set.
// Distances are geometric proximity estimates to fixed capture aim points; this
// script does not perform camera-frustum or occlusion raycasts.
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VILLAGE_BUILDING_OVERRIDES } from '../../src/environment/village-building-overrides.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const defaultOutDir = 'outputs/village-fidelity-20261004/inventory';
const outDirArg = args.find((value) => value.startsWith('--out-dir='))?.slice('--out-dir='.length)
  ?? (args.includes('--out-dir') ? args[args.indexOf('--out-dir') + 1] : undefined) ?? defaultOutDir;
const outArg = args.find((value) => value.startsWith('--out='))?.slice('--out='.length);
const checkOnly = args.includes('--check');
const outFile = resolve(root, outArg ?? `${outDirArg}/village-buildings.json`);
const readJson = (path) => JSON.parse(readFileSync(resolve(root, path), 'utf8'));

const derived = readJson('public/village/buildings.json');
const osm = readJson('data/gameplay/raw/osm_buildings_villafranca.json');
const heightMeta = readJson('public/village/building_height_grid.json');
const pilot = readJson('public/village/pilot-houses.json');
const ledger = readJson('assets/environment/real-structures/evidence.json');
const focalSites = readJson('public/village/focal-sites/manifest.json');
const osmById = new Map(osm.elements.map((element) => [element.id, element]));
const pilotById = new Map(pilot.buildings.map((building) => [building.osmWayId, building]));
const sourceEvidenceById = new Map();
for (const target of ledger.targets ?? []) {
  for (const id of target.osmWayIds ?? target.locatedBy?.osmWayIds ?? []) {
    sourceEvidenceById.set(id, target);
  }
}

const routeStart = { x: 3087.53, z: 3935.05 };
const facadeBuilding = derived.buildings.find((building) => building.id === 305647007);
if (!facadeBuilding) throw new Error('Missing facade capture target 305647007');
const polygonCenter = (points) => {
  let area2 = 0;
  let cx = 0;
  let cz = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    const cross = a[0] * b[1] - b[0] * a[1];
    area2 += cross;
    cx += (a[0] + b[0]) * cross;
    cz += (a[1] + b[1]) * cross;
  }
  if (Math.abs(area2) < 1e-9) {
    return [points.reduce((sum, p) => sum + p[0], 0) / points.length,
      points.reduce((sum, p) => sum + p[1], 0) / points.length];
  }
  return [cx / (3 * area2), cz / (3 * area2)];
};
const facadeAim = polygonCenter(facadeBuilding.footprint);
const villageCenter = derived.buildings.reduce((sum, building) => {
  for (const point of building.footprint) {
    sum.x += point[0];
    sum.z += point[1];
    sum.count++;
  }
  return sum;
}, { x: 0, z: 0, count: 0 });
const center = { x: villageCenter.x / villageCenter.count, z: villageCenter.z / villageCenter.count };
const streetDirection = { x: Math.sin(-3.037375), z: Math.cos(-3.037375) };
const views = {
  spawnStreetCamera: routeStart,
  calleMayorStreetLookTarget: {
    x: routeStart.x + streetDirection.x * 70,
    z: routeStart.z + streetDirection.z * 70,
  },
  plaza: { x: 3060, z: 3963 },
  calleMayorCapture1: { x: 3060, z: 3992 },
  calleMayorCapture2: { x: 3075, z: 3952 },
  church: { x: 3067.357, z: 3983.5 },
  facade305647007: { x: facadeAim[0], z: facadeAim[1] },
  aerialAim: { x: center.x + 40, z: center.z + 60 },
};

// Tier A is the fixed, auditable set selected for spawn/street/plaza/church
// inspection. It includes the targeted PNOA roof samples and central landmark.
const tierAIds = new Set([
  474364247, 474364248, 818885678, 1509797545, 1509797544, 305647007,
  310458426, 433198559, 474364245, 474649085, 310174514, 818885706,
  818885708, 818885703, 818885704, 818885707, 818885674, 818885675,
  818885676, 672017718, 90614388,
]);
tierAIds.delete(818885674);

const grid = heightMeta.grid;
const heightBytes = readFileSync(resolve(root, 'public/village', heightMeta.valuesFile));
const expectedBytes = grid.width * grid.height * 2;
if (heightBytes.length !== expectedBytes) throw new Error(`Height grid has ${heightBytes.length} bytes; expected ${expectedBytes}`);
const heightValues = new Int16Array(heightBytes.buffer, heightBytes.byteOffset, heightBytes.length / 2);
const terrainConfig = readJson('public/terrain/config.json');
const worldBounds = terrainConfig.bounds;
const worldE0 = worldBounds.e[0];
const worldN0 = worldBounds.n[0];
const worldScale = terrainConfig.worldScale;
const minLidarSamples = 4;
const gableElongation = 1.35;

function signedArea(points) {
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    area += a[0] * b[1] - b[0] * a[1];
  }
  return area / 2;
}

function centroid(points) {
  const area = signedArea(points);
  if (Math.abs(area) < 1e-9) return [
    points.reduce((sum, p) => sum + p[0], 0) / points.length,
    points.reduce((sum, p) => sum + p[1], 0) / points.length,
  ];
  let x = 0;
  let z = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    const cross = a[0] * b[1] - b[0] * a[1];
    x += (a[0] + b[0]) * cross;
    z += (a[1] + b[1]) * cross;
  }
  return [x / (6 * area), z / (6 * area)];
}

function principalAxis(points) {
  const c = centroid(points);
  let sxx = 0;
  let szz = 0;
  let sxz = 0;
  for (const point of points) {
    const dx = point[0] - c[0];
    const dz = point[1] - c[1];
    sxx += dx * dx;
    szz += dz * dz;
    sxz += dx * dz;
  }
  const theta = 0.5 * Math.atan2(2 * sxz, sxx - szz);
  const u = [Math.cos(theta), Math.sin(theta)];
  const v = [-u[1], u[0]];
  let halfU = 0;
  let halfV = 0;
  for (const point of points) {
    const dx = point[0] - c[0];
    const dz = point[1] - c[1];
    halfU = Math.max(halfU, Math.abs(dx * u[0] + dz * u[1]));
    halfV = Math.max(halfV, Math.abs(dx * v[0] + dz * v[1]));
  }
  return { c, u, halfU, halfV };
}

function isConvex(points) {
  let sign = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    const c = points[(i + 2) % points.length];
    const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (Math.abs(cross) < 1e-8) continue;
    const current = Math.sign(cross);
    if (sign && current !== sign) return false;
    sign = current;
  }
  return sign !== 0;
}

function containsPoint(points, x, z) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i];
    const b = points[j];
    if ((a[1] > z) !== (b[1] > z) && x < ((b[0] - a[0]) * (z - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

function lidarSamples(points) {
  const cols = points.map(([x]) => (worldE0 + x / worldScale - grid.top_left_easting_m) / grid.pixel_size_m);
  const rows = points.map(([, z]) => (grid.top_left_northing_m - (worldN0 + z / worldScale)) / grid.pixel_size_m);
  const colMin = Math.max(0, Math.floor(Math.min(...cols)));
  const colMax = Math.min(grid.width - 1, Math.floor(Math.max(...cols)));
  const rowMin = Math.max(0, Math.floor(Math.min(...rows)));
  const rowMax = Math.min(grid.height - 1, Math.floor(Math.max(...rows)));
  const result = [];
  for (let row = rowMin; row <= rowMax; row++) {
    for (let col = colMin; col <= colMax; col++) {
      const value = heightValues[row * grid.width + col];
      if (value <= 0) continue;
      const x = (grid.top_left_easting_m + (col + 0.5) * grid.pixel_size_m - worldE0) * worldScale;
      const z = (grid.top_left_northing_m - (row + 0.5) * grid.pixel_size_m - worldN0) * worldScale;
      if (containsPoint(points, x, z)) result.push(value);
    }
  }
  return result.sort((a, b) => a - b);
}

function distanceToFootprint(points, x, z) {
  let inside = false;
  let best = Infinity;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i];
    const b = points[j];
    if ((a[1] > z) !== (b[1] > z) && x < ((b[0] - a[0]) * (z - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / (dx * dx + dz * dz || 1)));
    best = Math.min(best, Math.hypot(x - (a[0] + dx * t), z - (a[1] + dz * t)));
  }
  return inside ? 0 : best;
}

function hash32(id) {
  let hash = (id ^ 0x9e3779b9) >>> 0;
  hash = Math.imul(hash ^ (hash >>> 16), 0x85ebca6b) >>> 0;
  hash = Math.imul(hash ^ (hash >>> 13), 0xc2b2ae35) >>> 0;
  return (hash ^ (hash >>> 16)) >>> 0;
}

const kitNames = ['calle-mayor', 'casa-rural', 'casa-cuadra'];
function facadeKitCandidate(id) {
  let hash = id | 0;
  hash = Math.imul(hash ^ (hash >>> 16), 0x45d9f3b);
  hash = Math.imul(hash ^ (hash >>> 16), 0x45d9f3b);
  hash ^= hash >>> 16;
  return kitNames[(hash >>> 0) % kitNames.length];
}

function round(value, places = 2) {
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
}

const records = derived.buildings.map((building) => {
  const element = osmById.get(building.id);
  const tags = element?.tags ?? {};
  const points = building.footprint;
  const axis = principalAxis(points);
  const elongation = axis.halfV > 0.5 ? axis.halfU / axis.halfV : 0;
  const area = Math.abs(signedArea(points));
  const safeHip = points.length <= 8 && area <= 800 && isConvex(points);
  const safeShed = points.length <= 16 && area <= 1000;
  const variant = hash32(building.id) % 4;
  const heuristicRoofShape = elongation >= gableElongation
    ? 'gable'
    : (safeHip && variant % 4 !== 0 ? 'hip' : (safeShed ? 'shed' : 'flat'));
  const override = VILLAGE_BUILDING_OVERRIDES[building.id];
  const roofShape = override?.roofShape ?? heuristicRoofShape;
  const samples = lidarSamples(points);
  const lidarP95 = samples.length ? samples[Math.floor((samples.length - 1) * 0.95)] : null;
  const pilotRecord = pilotById.get(building.id);
  // Runtime LiDAR height selection precedes roof overrides and uses PCA elongation.
  const roofRise = elongation >= gableElongation && axis.halfV > 0.5
    ? Math.min(Math.max(axis.halfV * 0.5, 0.4), 3) : 0;
  const lidarWallHeight = samples.length >= minLidarSamples && lidarP95 !== null
    ? lidarP95 - roofRise
    : null;
  const explicitOsmHeight = typeof tags.height === 'string' && Number.isFinite(Number.parseFloat(tags.height));
  const lidarUsable = !explicitOsmHeight && samples.length >= minLidarSamples
    && lidarWallHeight !== null && lidarWallHeight >= 2 && lidarWallHeight <= 60;
  const effectiveHeight = pilotRecord
    ? { metres: pilotRecord.heightM, source: `current pilot GLB LiDAR estimate (${pilotRecord.lidarSampleCount} cells)` }
    : explicitOsmHeight
    ? { metres: Number.parseFloat(tags.height), source: 'OSM height tag' }
    : (lidarUsable
      ? { metres: round(lidarWallHeight, 3), source: `IGN MDSnE P95 minus roof rise (${samples.length} cells)` }
      : { metres: building.heightM, source: `OSM/build derivation (${building.heightSource}); before any runtime terrain-clearance lift${samples.length < minLidarSamples ? `; LiDAR ${samples.length}/${minLidarSamples} cells` : '; LiDAR estimate failed runtime height bounds'}` });
  const distances = Object.fromEntries(Object.entries(views).map(([name, point]) => [name,
    round(distanceToFootprint(points, point.x, point.z))]));
  const minView = Object.entries(distances).sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))[0];
  const focalRecord = building.id === focalSites.assets?.church?.osmWayIds?.[0]
    ? focalSites.assets.church
    : null;
  const evidence = sourceEvidenceById.get(building.id);
  const referenceFile = `outputs/village-fidelity-20261004/references/${building.id}.json`;
  let freshPnoaReference = null;
  try {
    const reference = readJson(referenceFile);
    freshPnoaReference = {
      file: referenceFile,
      url: reference.url,
      bboxWgs84: reference.bbox,
      provider: reference.provider,
      license: reference.license,
      retrievedAt: reference.retrievedAt,
    };
  } catch {
    // A missing optional per-building capture is represented explicitly below.
  }
  const pnoaTags = Object.fromEntries(Object.entries(tags).filter(([key]) => key.startsWith('roof:')));
  const [cx, cz] = centroid(points);
  const lonLat = (element?.geometry ?? []).map(({ lon, lat }) => [lon, lat]);
  const bboxWgs84 = lonLat.length ? [
    Math.min(...lonLat.map(([lon]) => lon)), Math.min(...lonLat.map(([, lat]) => lat)),
    Math.max(...lonLat.map(([lon]) => lon)), Math.max(...lonLat.map(([, lat]) => lat)),
  ].map((value) => round(value, 7)) : null;
  const bboxWorld = [
    Math.min(...points.map(([x]) => x)), Math.min(...points.map(([, z]) => z)),
    Math.max(...points.map(([x]) => x)), Math.max(...points.map(([, z]) => z)),
  ].map((value) => round(value, 2));
  const pilotHeight = pilotRecord ? { metres: pilotRecord.heightM, lidarSamples: pilotRecord.lidarSampleCount } : null;
  const tier = tierAIds.has(building.id) ? 'A' : (minView[1] <= 80 ? 'B' : 'C');
  return {
    rankDistance: minView[1],
    tier,
    osmWayId: building.id,
    focusView: minView[0],
    distanceToCaptureAimM: distances,
    visibility: 'proximity estimate only; no frustum, terrain occlusion, building occlusion, or line-of-sight raycast',
    osm: {
      type: tags.building ?? null,
      name: tags.name ?? null,
      address: [tags['addr:street'], tags['addr:housenumber']].filter(Boolean).join(' ') || null,
      levels: tags['building:levels'] ?? null,
      heightTag: tags.height ?? null,
      roofTags: pnoaTags,
      roofTagsEvidence: Object.keys(pnoaTags).length ? 'explicit OSM tags' : 'no roof:* tags in versioned OSM snapshot',
    },
    geometry: {
      centroidWorldXZ: [round(cx), round(cz)],
      bboxWorldXZ: bboxWorld,
      bboxWgs84,
      footprintAreaM2: round(area, 1),
      vertexCount: points.length,
      convex: isConvex(points),
      principalAxisAzimuthDegFromNorth: round((Math.atan2(axis.u[0], axis.u[1]) * 180 / Math.PI + 180) % 180, 1),
      elongation: round(elongation, 3),
    },
    height: {
      osmOrDerivedMetres: building.heightM,
      source: building.heightSource,
      effectiveRuntimeEstimate: effectiveHeight,
      lidarP95AboveLocalTerrainM: lidarP95,
      lidarSampleCount: samples.length,
      pilotGlbHeightEvidence: pilotHeight,
    },
    roof: {
      kind: override?.roofKind ?? building.roofKind,
      sourceKind: building.roofKind,
      kindConfidence: tags['roof:material'] || tags['roof:colour'] ? 'OSM tag' : (override?.roofKind ? 'targeted art override informed by current orthophoto appearance; not measured material' : 'type-based art heuristic; not per-building evidence'),
      proceduralFallbackShape: roofShape,
      currentRenderedShape: focalRecord ? 'cross-gable landmark asset' : (pilotRecord?.roofShape ?? roofShape),
      currentRenderedRoofAxisDegFromNorth: pilotRecord?.ridgeAzimuthDeg ?? (override?.ridgeRadians !== undefined ? round((Math.atan2(Math.cos(override.ridgeRadians), Math.sin(override.ridgeRadians)) * 180 / Math.PI + 180) % 180, 1) : round((Math.atan2(axis.u[0], axis.u[1]) * 180 / Math.PI + 180) % 180, 1)),
      renderedAsset: focalRecord ? 'public/village/focal-sites/church.glb' : (pilotRecord ? 'public/village/pilot-houses.glb' : null),
      shapeConfidence: freshPnoaReference ? 'target-specific current PNOA reference available; visual interpretation still requires review' : (evidence ? `existing ledger: ${evidence.status}/${evidence.confidence}` : 'no target-specific roof ledger'),
      safeHipSurface: safeHip,
      safeShedSurface: safeShed,
      sourceReferences: [freshPnoaReference?.file, evidence?.sourceUrl].filter(Boolean),
    },
    facade: {
      selectedAtRuntime: pilotRecord ? 'curated pilot art style' : null,
      sharedKitCandidate: pilotRecord ? null : facadeKitCandidate(building.id),
      confidence: 'artistic reconstruction; OSM provides no individual facade evidence',
    },
    renderOwnership: focalRecord ? 'focal landmark asset covers the OSM footprint in runtime' : (pilotRecord ? 'batched pilot GLB replaces procedural building geometry' : 'procedural village building groups'),
  };
});

records.sort((a, b) => a.rankDistance - b.rankDistance || a.osmWayId - b.osmWayId);
const output = {
  schemaVersion: 1,
  purpose: 'Visible village building priority inventory; a planning aid, not proof of rendered visibility.',
  coordinateSystem: 'EPSG:25830 projected to world X=east, Z=north, metres',
  tierPolicy: {
    A: 'fixed twenty-ID focus set for spawn, Calle Mayor, church and plaza inspection',
    B: 'remaining buildings within 80 m of any capture aim point',
    C: 'remaining buildings beyond 80 m of every capture aim point',
    rank: 'ascending nearest polygon-to-aim-point distance; OSM way ID breaks ties',
  },
  captureAimPoints: views,
  visibilityLimit: 'Distances only. No camera frustum, raycast, screen-space projection, or occlusion test is run.',
  heightLimit: 'Fallback levels/type heights may receive a terrain-clearance lift in runtime; the inventory reports the pre-lift value. Roof height and facade construction remain artistic reconstructions.',
  sources: {
    osmSnapshot: osm.osm3s?.timestamp_osm_base ?? derived.meta?.fuente?.osm_timestamp,
    osmLicense: 'ODbL 1.0 (OpenStreetMap contributors)',
    ignGrid: {
      product: heightMeta.product,
      crs: heightMeta.crs,
      pixelSizeM: grid.pixel_size_m,
      fetchedAtUtc: heightMeta.sourceFetchedAtUtc,
      license: heightMeta.license,
      valuesFile: `public/village/${heightMeta.valuesFile}`,
    },
    targetSpecificPnoa: 'Per-ID reference records, when available, are linked; inspect their image and metadata before treating a roof shape or material as observed.',
  },
  counts: {
    total: records.length,
    tierA: records.filter((record) => record.tier === 'A').length,
    tierB: records.filter((record) => record.tier === 'B').length,
    tierC: records.filter((record) => record.tier === 'C').length,
  },
  buildings: records,
};
const serialized = `${JSON.stringify(output, null, 2)}\n`;
if (checkOnly) {
  let existing;
  try { existing = readFileSync(outFile, 'utf8'); } catch { throw new Error(`Inventory missing: ${outFile}; regenerate without --check`); }
  if (existing !== serialized) throw new Error(`Inventory is stale: ${outFile}; regenerate without --check`);
  console.log(`village fidelity inventory check: ${output.counts.total} buildings; A ${output.counts.tierA}, B ${output.counts.tierB}, C ${output.counts.tierC}`);
} else {
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, serialized);
  console.log(`village fidelity inventory: ${output.counts.total} buildings; A ${output.counts.tierA}, B ${output.counts.tierB}, C ${output.counts.tierC}`);
  console.log(`wrote ${outFile}`);
}
