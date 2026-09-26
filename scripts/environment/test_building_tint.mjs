import assert from 'node:assert/strict';
import { buildingRoofTint, buildingTint } from '../../src/environment/building-tint.ts';

const first = buildingTint(818885707);
assert.deepEqual(buildingTint(818885707), first, 'un edificio conserva el mismo tono entre cargas');
assert.equal(first.length, 3, 'el tinte RGB tiene tres canales');
for (const tint of [first, ...Array.from({ length: 32 }, (_, i) => buildingTint(1000 + i))]) {
  for (const channel of tint) {
    assert.ok(channel >= 0.9 && channel <= 1.1, `el canal ${channel} queda dentro del margen sutil`);
  }
}
const unique = new Set(Array.from({ length: 32 }, (_, i) => buildingTint(1000 + i).join(',')));
assert.ok(unique.size >= 24, `la mayoría de fachadas obtiene matices distintos (${unique.size}/32)`);

const firstRoof = buildingRoofTint(818885707);
assert.deepEqual(buildingRoofTint(818885707), firstRoof, 'un tejado conserva su tono entre cargas');
assert.equal(firstRoof.length, 3, 'el tinte del tejado tiene tres canales');
for (const tint of [firstRoof, ...Array.from({ length: 32 }, (_, i) => buildingRoofTint(2000 + i))]) {
  for (const channel of tint) {
    assert.ok(channel >= 0.8 && channel <= 1.2, `el tejado queda en una variación cálida moderada (${channel})`);
  }
}
const uniqueRoofs = new Set(Array.from({ length: 32 }, (_, i) => buildingRoofTint(2000 + i).join(',')));
assert.ok(uniqueRoofs.size >= 24, `los tejados obtienen matices distintos (${uniqueRoofs.size}/32)`);

console.log(`building tint: walls ${unique.size}/32, roofs ${uniqueRoofs.size}/32 distinct, deterministic`);
