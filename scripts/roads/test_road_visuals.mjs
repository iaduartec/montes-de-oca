import assert from 'node:assert/strict';
import {
  levelRoadProfile,
  calculateTriangleTerrainLift,
  ROAD_CLEARANCE_SAMPLES,
  ROAD_SURFACE_CLEARANCE_M,
  parseSpeedLimitKph,
  shouldMarkRoad,
  shouldPlaceSpeedSign,
} from '../../src/road-visuals.ts';

const distances = [0, 10, 20, 30, 40, 50, 60];
const terrain = [0, 0, 0, -0.8, 0, 0, 0];
const leveled = levelRoadProfile(distances, terrain, {
  radiusM: 20,
  maxFillM: 0.6,
  transitionM: 15,
});

assert.equal(leveled[0], terrain[0], 'el perfil conserva la cota en el extremo de la vía');
assert.equal(leveled.at(-1), terrain.at(-1), 'el perfil conserva la cota en el otro extremo');
assert.ok(leveled[3] > terrain[3] + 0.3, 'el suavizado rellena un bache largo del asfalto');
assert.ok(leveled.every((height, index) => height >= terrain[index]), 'la calzada nivelada no se entierra en el terreno');
assert.ok(
  leveled.every((height, index) => height - terrain[index] <= 0.6 + 1e-9),
  'el relleno queda limitado al máximo configurado',
);
assert.ok(
  Math.abs(leveled[3] - leveled[2]) < Math.abs(terrain[3] - terrain[2]),
  'el suavizado reduce el cambio de rasante que producía el bache',
);
assert.throws(() => levelRoadProfile([0, 1], [0], { radiusM: 1, maxFillM: 0.5, transitionM: 1 }));

assert.equal(ROAD_CLEARANCE_SAMPLES.length, 15, 'se prueban puntos interiores adicionales de cada triángulo vial');
const hiddenRidgeLift = calculateTriangleTerrainLift(
  [{ x: 0, y: 0, z: 0 }, { x: 4, y: 0, z: 0 }, { x: 0, y: 0, z: 4 }],
  (x, z) => Math.max(0, 0.5 * (1 - Math.hypot(x - 2, z - 1) / 0.1)),
  ROAD_SURFACE_CLEARANCE_M,
);
assert.ok(hiddenRidgeLift >= 0.62, 'el despeje detecta la cresta y mantiene 12 cm de margen');

const n120 = { class: 'ROAD', width: 7.5, ref: 'N-120', bridge: false, maxspeed: '90' };
assert.equal(shouldMarkRoad(n120), true, 'la nacional ancha recibe marcas de calzada');
assert.equal(shouldMarkRoad({ ...n120, bridge: true }), false, 'los puentes no reciben rayas drapeadas');
assert.equal(shouldMarkRoad({ ...n120, width: 5.5 }), false, 'las vías estrechas no reciben línea central');
assert.equal(shouldMarkRoad({ ...n120, class: 'TRACK' }), false, 'las pistas conservan su material de tierra');
assert.equal(parseSpeedLimitKph('50 km/h'), 50, 'se extrae una limitación OSM con unidades');
assert.equal(parseSpeedLimitKph('signals'), null, 'las limitaciones no numéricas no inventan una señal');
assert.equal(shouldPlaceSpeedSign(n120, 150), true, 'la N-120 con velocidad publicada recibe señal');
assert.equal(shouldPlaceSpeedSign(n120, 149), false, 'los segmentos muy cortos no amontonan señales');
assert.equal(shouldPlaceSpeedSign({ ...n120, maxspeed: '' }, 1000), false, 'sin dato de velocidad no se inventa el límite');

console.log('road visuals: 18/18 checks OK');
