// Read-only extraction of the rendered pavement/skirt vertices around the
// paired junction outliers, using the same isolated sources as the captures.
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import ts from 'typescript';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine.js';
import { Scene } from '@babylonjs/core/scene.js';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';

const root = resolve('outputs/village-fidelity-20261004/road-visual-pair');
const results = {};
const generated = [];

async function moduleFrom(file, source = readFileSync(file, 'utf8')) {
  const dest = file.replace('.ts', '.triangle-inspect.mjs');
  let code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  code = code.replace(/(['"])(@babylonjs\/core\/[^'"]+)\1/g, '$1$2.js$1')
    .replace(/(['"])(\.\.?\/[^'"]+)\1/g, (_m, q, rel) => `${q}${rel}.triangle-inspect.mjs${q}`);
  writeFileSync(dest, code); generated.push(dest);
  return import(pathToFileURL(dest).href);
}

try {
  for (const phase of ['before', 'after']) {
    const app = resolve(root, phase), src = resolve(app, 'src');
    const heightfield = await moduleFrom(resolve(src, 'heightfield.ts'));
    await moduleFrom(resolve(src, 'world/road-surface.ts'));
    await moduleFrom(resolve(src, 'road-visuals.ts'));
    await moduleFrom(resolve(src, 'road-profile.ts'));
    let draping = readFileSync(resolve(src, 'road-draping.ts'), 'utf8');
    const needle = '  return {\n    meshes,\n    surface:';
    if (!draping.includes(needle)) throw new Error(`${phase}: did not find road network result object`);
    draping = draping.replace(needle, '  return {\n    diagnosticBands: CLASSES.map((cls) => ({ class: cls, ...typed[cls] })),\n    meshes,\n    surface:');
    const { loadRoadNetwork } = await moduleFrom(resolve(src, 'road-draping.ts'), draping);
    const config = JSON.parse(readFileSync(resolve(app, 'public/terrain/config.json'), 'utf8'));
    const tiles = config.tiles.map(tile => heightfield.createHeightfield(JSON.parse(readFileSync(resolve(app, `public${tile.url}`), 'utf8')).grid, config.worldScale));
    const terrain = {
      heightAt(x, z) {
        x = Math.max(0, Math.min(6000, x)); z = Math.max(0, Math.min(6000, z));
        const tile = tiles.find(t => x >= t.grid.x0 && z >= t.grid.z0 && x <= t.grid.x0 + 1000 && z <= t.grid.z0 + 1000);
        if (!tile) throw new Error(`No terrain tile covers ${x},${z}`);
        return tile.heightAt(x, z) - config.verticalDatum;
      },
      normalAt(x, z, out) {
        const e = 0.1;
        return (out ?? new Vector3()).set(
          -(this.heightAt(x + e, z) - this.heightAt(x - e, z)) / (2 * e), 1,
          -(this.heightAt(x, z + e) - this.heightAt(x, z - e)) / (2 * e),
        ).normalize();
      },
    };
    const roads = JSON.parse(readFileSync(resolve(app, 'public/roads/roads.json'), 'utf8')).roads;
    const engine = new NullEngine(), scene = new Scene(engine);
    const network = await loadRoadNetwork(scene, terrain, { fetchImpl: async () => ({ ok: true, json: async () => ({ roads }) }) });
    const band = network.diagnosticBands.find(value => value.class === 'ROAD');
    console.log(phase, 'band', Object.keys(band), { positions: band.positions?.length, indices: band.indices?.length, roles: band.roles?.length, example: band.indices?.slice?.(0, 6) });
    const wanted = { pavement: 61626, skirt: 61618 };
    const triangles = {};
    for (const [role, triangle] of Object.entries(wanted)) {
      const vertexIds = band.indices.slice(triangle * 3, triangle * 3 + 3);
      const vertices = Array.from(vertexIds, v => ({
        index: v, roleCode: band.roles[v], x: band.positions[v * 3], y: band.positions[v * 3 + 1], z: band.positions[v * 3 + 2],
      }));
      const [a, b, c] = vertices;
      const ab = [b.x - a.x, b.y - a.y, b.z - a.z], ac = [c.x - a.x, c.y - a.y, c.z - a.z];
      const n = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
      triangles[role] = { triangle, vertices, ySpanM: Math.max(...vertices.map(v => v.y)) - Math.min(...vertices.map(v => v.y)), gradeRatio: Math.hypot(n[0], n[2]) / Math.max(1e-12, Math.abs(n[1])), slopeDeg: Math.atan2(Math.hypot(n[0], n[2]), Math.abs(n[1])) * 180 / Math.PI };
    }
    results[phase] = { triangles };
    network.dispose(); engine.dispose();
  }
  writeFileSync(resolve(root, 'skirt-triangle-vertices.json'), `${JSON.stringify(results, null, 2)}\n`);
  console.log(JSON.stringify(results, null, 2));
} finally {
  for (const file of generated) rmSync(file, { force: true });
}
