import assert from 'node:assert/strict';
import { vegetationInstanceTint } from '../../src/environment/vegetation-profile.ts';

const first = vegetationInstanceTint(3087.53, 3935.05);
assert.deepEqual(vegetationInstanceTint(3087.53, 3935.05), first, 'un árbol conserva el mismo matiz');
assert.equal(first.length, 3, 'el tinte de instancia es RGB');

const palette = Array.from({ length: 32 }, (_, i) => vegetationInstanceTint(100 + i * 7.25, 200 + i * 3.5));
for (const color of palette) {
  for (const channel of color) {
    assert.ok(channel >= 0.9 && channel <= 1.1, `variación sutil dentro de paleta: ${channel}`);
  }
}
const unique = new Set(palette.map((color) => color.join(',')));
assert.ok(unique.size >= 28, `la mayoría de ejemplares rompe el tono clonado (${unique.size}/32)`);

console.log(`vegetation instance tint: ${unique.size}/32 colors stable and bounded`);
