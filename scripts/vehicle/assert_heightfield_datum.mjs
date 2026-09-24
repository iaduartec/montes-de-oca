// Aserción del FOOTGUN de los dos `heightAt` (FASE 4).
//
//   createHeightfield(grid, scale).heightAt(x, z)  -> metros ABSOLUTOS (944.5484)
//   terrain.heightAt(x, z)                          -> Y de MUNDO     (74.5484)
//
// Ambas difieren EXACTAMENTE en `verticalDatum`. Este script transpila el
// `worldHeightFromSampler` REAL de `src/terrain.ts` (la única traducción que usa
// el juego) y lo contrasta contra:
//   (a) la relación algebraica `mundo === absoluto − datum`, y
//   (b) los valores ya verificados en `docs/terrain/crosscheck.json` (datos
//       independientes: `game_abs_m` y `game_world_y`).
// Si alguien deja de restar el datum, (b) falla.
//
// Uso: node scripts/vehicle/assert_heightfield_datum.mjs
import { readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const tmpDir = resolve(here, '.assert-datum');

function transpile(relPath, outName) {
  const source = resolve(root, relPath);
  const text = ts.transpileModule(readFileSync(source, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, verbatimModuleSyntax: false },
  }).outputText;
  return { outFile: resolve(tmpDir, outName), text };
}

rmSync(tmpDir, { recursive: true, force: true });
mkdirSync(tmpDir, { recursive: true });

// Se transpilan las dependencias y se reescriben los imports relativos a los
// nombres generados; Babylon se resuelve desde node_modules.
const files = [
  transpile('src/config.ts', 'config.gen.mjs'),
  transpile('src/heightfield.ts', 'heightfield.gen.mjs'),
  transpile('src/terrain.ts', 'terrain.gen.mjs'),
];
for (const f of files) {
  const rewritten = f.text
    .replace(/(['"])\.\/config\1/g, '$1./config.gen.mjs$1')
    .replace(/(['"])\.\/heightfield\1/g, '$1./heightfield.gen.mjs$1')
    .replace(/(['"])(@babylonjs\/core\/[^'"]+)\1/g, '$1$2.js$1');
  writeFileSync(f.outFile, rewritten);
}

let worldHeightFromSampler;
let createHeightfield;
try {
  ({ worldHeightFromSampler } = await import(pathToFileURL(resolve(tmpDir, 'terrain.gen.mjs')).href));
  ({ createHeightfield } = await import(pathToFileURL(resolve(tmpDir, 'heightfield.gen.mjs')).href));
} finally {
  rmSync(tmpDir, { recursive: true, force: true });
}

const config = JSON.parse(readFileSync(resolve(root, 'public/terrain/config.json'), 'utf8'));
const datum = config.verticalDatum * config.worldScale;
const crosscheck = JSON.parse(readFileSync(resolve(root, 'docs/terrain/crosscheck.json'), 'utf8'));

const cache = new Map();
function samplerFor(tileId) {
  if (!cache.has(tileId)) {
    const tile = JSON.parse(readFileSync(resolve(root, 'public/terrain/tiles', `${tileId}.json`), 'utf8'));
    cache.set(tileId, createHeightfield(tile.grid, config.worldScale));
  }
  return cache.get(tileId);
}

let ok = true;
const rows = [];
for (const point of crosscheck.puntos) {
  const sampler = samplerFor(point.tile);
  const absolute = sampler.heightAt(point.world_x, point.world_z);
  const world = worldHeightFromSampler(sampler, datum, point.world_x, point.world_z);

  const algebraic = world - (absolute - datum); // debe ser 0
  const againstVerified = world - point.game_world_y; // contra crosscheck histórico
  const absAgainstVerified = absolute - point.game_abs_m;

  const pass = Math.abs(algebraic) < 1e-9 && Math.abs(againstVerified) < 1e-6 && Math.abs(absAgainstVerified) < 1e-6;
  ok = ok && pass;
  rows.push({
    nombre: point.nombre,
    tile: point.tile,
    absoluto_m: Number(absolute.toFixed(4)),
    mundo_y: Number(world.toFixed(4)),
    diff_con_datum_m: Number(algebraic.toExponential(2)),
    crosscheck_game_abs_m: point.game_abs_m,
    crosscheck_game_world_y: point.game_world_y,
    pass,
  });
}

console.log(`verticalDatum = ${datum} m`);
for (const r of rows) {
  console.log(
    `${r.nombre.padEnd(22)} abs=${r.absoluto_m.toFixed(4)} mundo=${r.mundo_y.toFixed(4)} ` +
      `(abs−mundo=${(r.absoluto_m - r.mundo_y).toFixed(4)} = datum) pass=${r.pass}`,
  );
}
console.log(`\n=> ${ok ? 'OK' : 'FALLA'}: los dos heightAt difieren exactamente en verticalDatum.`);
if (!ok) process.exit(1);
