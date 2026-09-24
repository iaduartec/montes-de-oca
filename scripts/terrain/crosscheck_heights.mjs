// Chequeo cruzado obligatorio: altura del DEM original vs `heightAt()` REAL del
// juego (se transpila src/heightfield.ts con el `typescript` del proyecto y se
// ejecuta en Node; no se agregan dependencias).
//
// Salida: docs/terrain/crosscheck.json
//
// Uso: node scripts/terrain/crosscheck_heights.mjs
import { readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');

const heightfieldSrc = resolve(root, 'src', 'heightfield.ts');
const genFile = resolve(here, '.heightfield.gen.mjs');
const pointsFile = resolve(root, 'docs', 'terrain', 'crosscheck_dem_tiles.json');
const configFile = resolve(root, 'public', 'terrain', 'config.json');
const outFile = resolve(root, 'docs', 'terrain', 'crosscheck.json');

const transpiled = ts.transpileModule(readFileSync(heightfieldSrc, 'utf8'), {
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
    verbatimModuleSyntax: false,
  },
}).outputText;
// Se agregan extensiones: la del import relativo (si hubiera) y la de los imports
// de Babylon (paquete ESM que exige .js). Vive dentro del proyecto, así Node
// resuelve @babylonjs/core desde node_modules.
const withExtensions = transpiled
  .replace(/(['"])(\.\/[^'"]+)\1/g, '$1$2.mjs$1')
  .replace(/(['"])(@babylonjs\/core\/[^'"]+)\1/g, '$1$2.js$1');
writeFileSync(genFile, withExtensions);

let createHeightfield;
try {
  ({ createHeightfield } = await import(pathToFileURL(genFile).href));
} finally {
  if (existsSync(genFile)) rmSync(genFile);
}

const config = JSON.parse(readFileSync(configFile, 'utf8'));
const { puntos } = JSON.parse(readFileSync(pointsFile, 'utf8'));

// Cache de samplers por tile.
const cache = new Map();
function samplerFor(tileId) {
  if (cache.has(tileId)) return cache.get(tileId);
  const tile = JSON.parse(readFileSync(resolve(root, 'public', 'terrain', 'tiles', `${tileId}.json`), 'utf8'));
  const sampler = createHeightfield(tile.grid, config.worldScale);
  cache.set(tileId, sampler);
  return sampler;
}

const datum = config.verticalDatum * config.worldScale;
const rows = [];
let maxAbs = 0;
for (const point of puntos) {
  // `heightAt` del juego devuelve Y de mundo (datum restado). El DEM original está
  // en metros absolutos: se compara en la misma referencia.
  const gameRaw = samplerFor(point.tile).heightAt(point.world_x, point.world_z); // metros absolutos
  const gameWorldY = gameRaw - datum;
  const demWorldY = point.dem_m - datum;
  const diff = gameWorldY - demWorldY;
  maxAbs = Math.max(maxAbs, Math.abs(diff));
  rows.push({
    nombre: point.nombre,
    e: point.e,
    n: point.n,
    world_x: point.world_x,
    world_z: point.world_z,
    tile: point.tile,
    dem_abs_m: point.dem_m,
    game_abs_m: Number(gameRaw.toFixed(4)),
    game_world_y: Number(gameWorldY.toFixed(4)),
    diff_m: Number(diff.toFixed(6)),
  });
}

const report = {
  descripcion:
    'Altura del DEM original MDT05 vs heightAt() real de src/heightfield.ts (transpilado con el ' +
    'typescript del proyecto). Máxima diferencia abs. requerida: submétrica (acá se exige < 1e-3 m).',
  verticalDatum_m: datum,
  diff_max_abs_m: Number(maxAbs.toFixed(8)),
  aprobado: maxAbs < 1e-3,
  puntos: rows,
};
writeFileSync(outFile, JSON.stringify(report, null, 2) + '\n');

for (const r of rows) {
  console.log(
    `${r.nombre.padEnd(22)} E=${r.e.toFixed(1)} N=${r.n.toFixed(1)} tile=${r.tile} ` +
      `DEM=${r.dem_abs_m.toFixed(3)} juego=${r.game_abs_m.toFixed(3)} diff=${r.diff_m.toFixed(6)} m`,
  );
}
console.log(`\ndiff_max_abs = ${report.diff_max_abs_m} m -> ${report.aprobado ? 'OK' : 'FALLA'}`);
console.log(`=> ${outFile}`);
if (!report.aprobado) process.exit(1);
