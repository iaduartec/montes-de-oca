import assert from 'node:assert/strict';
import { selectRoofShape } from '../../src/environment/roof-shape.ts';

assert.equal(
  selectRoofShape({ elongated: true, hipAllowed: true, shedAllowed: true, variant: 0 }),
  'gable',
  'las plantas alargadas usan dos aguas',
);
assert.equal(
  selectRoofShape({ elongated: false, hipAllowed: true, shedAllowed: true, variant: 0 }),
  'shed',
  'la variante 0 usa un agua',
);
for (const variant of [1, 2, 3]) {
  assert.equal(
    selectRoofShape({ elongated: false, hipAllowed: true, shedAllowed: true, variant }),
    'hip',
    `la variante ${variant} usa cuatro aguas`,
  );
}
assert.equal(
  selectRoofShape({ elongated: false, hipAllowed: false, shedAllowed: true, variant: 1 }),
  'shed',
  'si hip no es seguro conserva cubierta inclinada segura',
);
assert.equal(
  selectRoofShape({ elongated: false, hipAllowed: false, shedAllowed: false, variant: 1 }),
  'flat',
  'huellas no seguras quedan planas',
);

console.log('roof shape: 7/7 checks OK');
