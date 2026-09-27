#!/usr/bin/env node
// Evidence ledger for the real-structure corrections.
//
// Task 1 of docs/superpowers/plans/2026-09-27-real-structures-and-vehicle-catalog.md:
// every target needs a dated, located real image and, where a correction is
// claimed, a visible discrepancy plus the exact change. Targets without
// demonstrable evidence are recorded as explicit release blockers instead of
// being filled with assumptions.
//
//   node scripts/environment/validate_real_structure_evidence.mjs [--phase=source|final]
//
// `--phase=source` (default) checks the ledger is internally consistent and
// every OSM way matches the versioned raw data. `--phase=final` is the release
// gate: it also demands that no blocker remains and that each corrected target
// is reflected in the shipped asset.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const phaseArg = args.find((value) => value.startsWith('--phase='));
const phase = phaseArg ? phaseArg.slice('--phase='.length) : 'source';
if (phase !== 'source' && phase !== 'final') {
  console.error(`unknown phase "${phase}" (expected source or final)`);
  process.exit(1);
}

let pass = 0;
const fails = [];
function check(name, ok, detail = '') {
  if (ok) {
    pass++;
    console.log(`[OK  ] ${name}${detail ? ' — ' + detail : ''}`);
  } else {
    fails.push(name);
    console.log(`[FALLA] ${name}${detail ? ' — ' + detail : ''}`);
  }
}

const ledger = JSON.parse(readFileSync(resolve(root, 'assets/environment/real-structures/evidence.json'), 'utf8'));
const rawBuildings = JSON.parse(readFileSync(resolve(root, 'data/gameplay/raw/osm_buildings_villafranca.json'), 'utf8')).elements;
const rawWater = JSON.parse(readFileSync(resolve(root, 'data/water/raw/osm_water_window.json'), 'utf8')).elements;
const rawRoads = JSON.parse(readFileSync(resolve(root, 'data/roads/raw/osm_highways_window.json'), 'utf8')).elements;
const rawById = new Map([...rawBuildings, ...rawWater, ...rawRoads].map((element) => [element.id, element]));

const EXPECTED_TARGETS = 11;
const source = ledger.source ?? {};
check('esquema versionado', ledger.schemaVersion === 1, `schemaVersion ${ledger.schemaVersion}`);
check('la fuente esta fechada y localizada',
  typeof source.name === 'string' && source.name.length > 0
  && Number.isInteger(source.captureYear)
  && typeof source.license === 'string'
  && typeof source.service === 'string'
  && typeof source.metadataRecord === 'string'
  && typeof source.gsdM === 'number',
  `${source.name} · ${source.captureYear} · ${source.license}`);
check('la fuente declara solo planta/cubierta',
  typeof source.note === 'string' && /planta/i.test(source.note) && /fachada/i.test(source.note),
  source.note ? 'nota presente' : 'falta nota');

const targets = Array.isArray(ledger.targets) ? ledger.targets : [];
check(`hay ${EXPECTED_TARGETS} objetivos`, targets.length === EXPECTED_TARGETS, `${targets.length} registros`);
check('ids unicos', new Set(targets.map((target) => target.id)).size === targets.length);

function bboxOfWays(ids) {
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  for (const id of ids) {
    const element = rawById.get(id);
    if (!element) return null;
    for (const point of element.geometry) {
      minLon = Math.min(minLon, point.lon);
      minLat = Math.min(minLat, point.lat);
      maxLon = Math.max(maxLon, point.lon);
      maxLat = Math.max(maxLat, point.lat);
    }
  }
  return [minLon, minLat, maxLon, maxLat];
}

let corrected = 0;
let blocked = 0;
for (const target of targets) {
  const label = target.id ?? '(sin id)';
  const locatedBy = target.locatedBy ?? {};
  const ways = Array.isArray(locatedBy.osmWayIds) ? locatedBy.osmWayIds : [];
  check(`${label}: ways OSM declarados`, ways.length > 0, ways.join(', '));
  const matched = ways.every((id) => rawById.has(id));
  check(`${label}: ways presentes en el crudo versionado`, matched);
  const rawBounds = matched ? bboxOfWays(ways) : null;
  const declared = locatedBy.wgs84Bounds;
  const boundsMatch = rawBounds && Array.isArray(declared) && declared.length === 4
    && declared.every((value, index) => Math.abs(value - rawBounds[index]) < 1e-5);
  check(`${label}: bounds WGS84 coinciden con el crudo`, Boolean(boundsMatch),
    rawBounds ? `crudo ${rawBounds.map((v) => v.toFixed(5)).join(',')}` : 'sin crudo');
  check(`${label}: imagen real localizada`,
    typeof target.sourceUrl === 'string' && target.sourceUrl.startsWith('https://') && target.sourceUrl.includes('BBOX='));
  check(`${label}: autoria y licencia`,
    typeof target.author === 'string' && target.author.length > 0
    && typeof target.license === 'string' && target.license.length > 0,
    `${target.author} · ${target.license}`);
  check(`${label}: fecha de captura`,
    typeof target.capturedAt === 'string' && /20\d\d/.test(target.capturedAt), target.capturedAt);
  check(`${label}: confianza declarada`,
    ['observado', 'aproximado', 'sin evidencia'].includes(target.confidence), target.confidence);

  if (target.status === 'corrected') {
    corrected++;
    check(`${label}: discrepancia visible`, typeof target.visibleFeature === 'string' && target.visibleFeature.length > 10);
    check(`${label}: estado anterior descrito`, typeof target.before === 'string' && target.before.length > 10);
    check(`${label}: correccion propuesta`, typeof target.proposedCorrection === 'string' && target.proposedCorrection.length > 10);
    check(`${label}: resultado descrito`, typeof target.after === 'string' && target.after.length > 10);
    const comparison = target.comparison ?? {};
    check(`${label}: comparacion antes/despues`,
      typeof comparison.beforeView === 'string' && typeof comparison.afterView === 'string',
      `${comparison.beforeView ?? '?'} -> ${comparison.afterView ?? '?'}`);
    check(`${label}: la correccion no reclama fachada/vertical`,
      !/fachada|vertical|alero|ventana|puerta/i.test(`${target.proposedCorrection} ${target.after}`), 'solo planta/cubierta');
    if (phase === 'final') {
      check(`${label}: vista previa existe`, existsSync(resolve(root, comparison.beforeView ?? '')),
        comparison.beforeView ?? '');
      check(`${label}: vista posterior existe`, existsSync(resolve(root, comparison.afterView ?? '')),
        comparison.afterView ?? '');
    }
  } else if (target.status === 'blocked') {
    blocked++;
    check(`${label}: blocker justificado`, typeof target.blockerReason === 'string' && target.blockerReason.length > 10);
    check(`${label}: no inventa correccion`, target.proposedCorrection === undefined);
  } else {
    check(`${label}: estado valido`, false, `status "${target.status}"`);
  }
}

if (phase === 'final') {
  check('sin release blockers', blocked === 0, `${blocked} blockers pendientes`);
  const pilot = JSON.parse(readFileSync(resolve(root, 'public/village/pilot-houses.json'), 'utf8'));
  for (const target of targets.filter((entry) => entry.kind === 'pilot-house' && entry.status === 'corrected')) {
    const record = pilot.buildings.find((building) => building.osmWayId === target.locatedBy.osmWayIds[0]);
    check(`${target.id}: manifiesto del piloto refleja la correccion`,
      Boolean(record) && record.roofShape === 'gable',
      record ? `roofShape ${record.roofShape}` : 'sin registro');
  }
  const dam = targets.find((entry) => entry.kind === 'dam' && entry.status === 'corrected');
  if (dam) {
    const focal = JSON.parse(readFileSync(resolve(root, 'public/village/focal-sites/manifest.json'), 'utf8'));
    check(`${dam.id}: manifiesto focal refleja la coronacion curva`,
      (focal.assets?.dam?.crestPoints ?? 0) >= 3, `crestPoints ${focal.assets?.dam?.crestPoints}`);
  }
}

console.log(`\n${pass} checks OK · ${corrected} corregidos · ${blocked} blockers · fase ${phase}`);
if (fails.length > 0) {
  console.log(`FALLAN ${fails.length}: ${fails.join(' | ')}`);
  process.exit(1);
}
console.log('TODO OK');
