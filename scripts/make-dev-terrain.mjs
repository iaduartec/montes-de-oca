// Genera un tile de terreno procedural y determinista para que la app arranque
// sin esperar los datos reales de la FASE 2 (DEM IGN MDT05, 5 m, EPSG:25830).
//
// Uso:  npm run make:dev-terrain
// Salida: public/terrain/dev-tile.json
//
// El esquema es EXACTAMENTE el de la referencia: {schemaVersion:1, id, grid}.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, '..');
const outputPath = resolve(projectRoot, 'public/terrain/dev-tile.json');

// Grilla de prueba: 256×256 muestras cada 5 m → 1275 m × 1275 m.
const COLUMNS = 256;
const ROWS = 256;
const DX = 5;
const DZ = 5;
const TILE_ID = 'dev-tile';

// El tile se centra en el origen del mundo; el config define dónde cae eso en
// coordenadas geográficas. Acá no hay ningún número de Villafranca.
const X0 = (-(COLUMNS - 1) * DX) / 2;
const Z0 = (-(ROWS - 1) * DZ) / 2;

/** Hash entero determinista y barato. Devuelve un valor en [0, 1). */
function hash2(ix, iz) {
  let h = Math.imul(ix, 374761393) + Math.imul(iz, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Suavizado tipo smoothstep. */
function fade(t) {
  return t * t * (3 - 2 * t);
}

/** Ruido de valor bilineal sobre una grilla entera. */
function valueNoise(x, z) {
  const xi = Math.floor(x);
  const zi = Math.floor(z);
  const tx = fade(x - xi);
  const tz = fade(z - zi);
  const a = hash2(xi, zi);
  const b = hash2(xi + 1, zi);
  const c = hash2(xi, zi + 1);
  const d = hash2(xi + 1, zi + 1);
  const top = a + (b - a) * tx;
  const bottom = c + (d - c) * tx;
  return top + (bottom - top) * tz;
}

/** Ruido fractal (varias octavas) en [-1, 1]. */
function fbm(x, z) {
  let sum = 0;
  let amplitude = 1;
  let frequency = 1;
  let norm = 0;
  for (let octave = 0; octave < 4; octave++) {
    sum += amplitude * (valueNoise(x * frequency, z * frequency) * 2 - 1);
    norm += amplitude;
    amplitude *= 0.5;
    frequency *= 2;
  }
  return sum / norm;
}

/**
 * Altura procedural: colinas suaves + una loma marcada + un valle de río que
 * serpentea. Todo en metros.
 */
function heightAt(x, z) {
  const hills = fbm(x * 0.0022, z * 0.0022) * 42; // relieve general
  const ridge = Math.max(0, 1 - Math.hypot(x - 260, z + 180) / 620); // loma al NE
  const ridgeHeight = ridge * ridge * 48;
  const riverX = 70 * Math.sin(z * 0.0016); // cauce que serpentea
  const distanceToRiver = Math.abs(x - riverX);
  const riverDepth = Math.exp(-(distanceToRiver * distanceToRiver) / (2 * 90 * 90)) * 26;
  return hills + ridgeHeight - riverDepth + 30;
}

const heights = new Array(COLUMNS * ROWS);
for (let j = 0; j < ROWS; j++) {
  const z = Z0 + j * DZ;
  for (let i = 0; i < COLUMNS; i++) {
    const x = X0 + i * DX;
    heights[j * COLUMNS + i] = Math.round(heightAt(x, z) * 100) / 100;
  }
}

const tile = {
  schemaVersion: 1,
  id: TILE_ID,
  grid: {
    x0: X0,
    z0: Z0,
    dx: DX,
    dz: DZ,
    columns: COLUMNS,
    rows: ROWS,
    heights,
  },
};

// Invariante del esquema: heights.length === columns * rows.
if (heights.length !== COLUMNS * ROWS) {
  throw new Error('invariante roto: heights.length !== columns * rows');
}

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, JSON.stringify(tile));

const sizeKb = (Buffer.byteLength(JSON.stringify(tile)) / 1024).toFixed(0);
console.log(
  `dev-tile: ${COLUMNS}×${ROWS} celdas, paso ${DX} m, ${(COLUMNS - 1) * DX}×${(ROWS - 1) * DZ} m, ${sizeKb} KB → ${outputPath}`,
);
