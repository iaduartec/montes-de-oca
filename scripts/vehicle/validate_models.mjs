import { readFileSync } from 'node:fs';

const presets = readFileSync('src/vehicle/presets.ts', 'utf8');
const model = readFileSync('src/vehicle/model.ts', 'utf8');
const integration = readFileSync('src/main.ts', 'utf8');
const appearances = [...presets.matchAll(/id: '([^']+)'[\s\S]*?visual: '([^']+)'/g)].map((match) => match[2]);
const expected = ['estandar', 'patrulla', 'carga'];
if (JSON.stringify(appearances) !== JSON.stringify(expected)) {
  throw new Error(`Identidades visuales de presets incorrectas: ${appearances.join(', ')}`);
}
for (const marker of [
  'setAppearance',
  "id === 'patrulla'",
  "id === 'carga'",
  'vehicle:variant-patrulla',
  'vehicle:patrol-wagon-roof',
  'vehicle:patrol-side-glass',
  'vehicle:variant-carga',
  'vehicle:cargo-bed',
]) {
  if (!model.includes(marker)) throw new Error(`Falta en model.ts: ${marker}`);
}
if (!integration.includes('vehicle.setAppearance(preset.visual)')) throw new Error('aplicarPreset no sincroniza la carrocería');
if (!/applyPreset\(vehicle\.params, preset\);\s*vehicle\.setAppearance\(preset\.visual\);/.test(integration)) {
  throw new Error('La apariencia no se aplica en el mismo flujo que la afinación física');
}
console.log('OK modelos de vehículo: tres identidades y kits intercambiables sin tocar la física');
