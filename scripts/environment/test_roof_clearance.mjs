import assert from 'node:assert/strict';
import {
  constrainEaveOverhang,
  VILLAGE_DETAIL_RADIUS_M,
  VILLAGE_ROAD_CLEARANCE_QUERY_RADIUS_M,
} from '../../src/environment/roof-clearance.ts';

const edge = { ax: 0, az: 0, bx: 10, bz: 0, nx: 0, nz: -1 };
const maximum = 0.35;

assert.equal(constrainEaveOverhang(edge, [], maximum), maximum, 'sin carreteras conserva el alero completo');
assert.equal(
  constrainEaveOverhang(edge, [{ x: 5, z: -3.4, radiusM: 3.6 }], maximum),
  0,
  'una carretera pegada al alero elimina el vuelo que invadiría su banda protegida',
);
assert.equal(
  constrainEaveOverhang(edge, [{ x: 5, z: -4.1, radiusM: 3.6 }], maximum),
  maximum,
  'con hueco suficiente se preserva el alero nominal',
);
assert.ok(
  Math.abs(constrainEaveOverhang(edge, [{ x: 5, z: -4.0, radiusM: 3.6 }], maximum) - 0.3) < 1e-9,
  'el borde del alero mantiene 10 cm de separación del corredor vial',
);
assert.equal(
  constrainEaveOverhang(edge, [{ x: 5, z: 4, radiusM: 3.6 }], maximum),
  0,
  'un eje que entra en la huella tampoco permite que el alero avance hacia su corredor',
);
assert.equal(
  constrainEaveOverhang(edge, [{ x: 20, z: -0.1, radiusM: 1 }], maximum),
  maximum,
  'una carretera más allá del extremo de la fachada no recorta un lado sin relación',
);
assert.ok(
  VILLAGE_ROAD_CLEARANCE_QUERY_RADIUS_M - VILLAGE_DETAIL_RADIUS_M >= 5.2 + maximum + 0.1,
  'la selección de estaciones cubre casas detalladas, radio máximo de vía, alero y separación',
);

console.log('roof eave road clearance: 7/7 checks OK');
