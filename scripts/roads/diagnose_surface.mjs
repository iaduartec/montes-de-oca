import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import ts from 'typescript';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
const generated = [];
async function moduleFrom(path, source = readFileSync(path, 'utf8')) { const dest = path.replace('.ts', '.diagnostic.mjs'); let code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText.replace(/(['"])(@babylonjs\/core\/[^'"]+)\1/g, '$1$2.js$1'); writeFileSync(dest, code); generated.push(dest); code = code.replace(/(['"])(\.\.?\/[^'"]+)\1/g, (match, quote, rel) => quote + rel + '.diagnostic.mjs' + quote); writeFileSync(dest, code); return import(pathToFileURL(process.cwd() + '/' + dest).href); }
try {
    const { createHeightfield } = await moduleFrom('src/heightfield.ts');
    const cfg = JSON.parse(readFileSync('public/terrain/config.json', 'utf8'));
    const samplers = cfg.tiles.map(t => createHeightfield(JSON.parse(readFileSync('public' + t.url, 'utf8')).grid, cfg.worldScale));
    const terrain = { heightAt(x, z) { x = Math.max(0, Math.min(6000, x)); z = Math.max(0, Math.min(6000, z)); const s = samplers.find(s => x >= s.grid.x0 && z >= s.grid.z0 && x <= s.grid.x0 + 1000 && z <= s.grid.z0 + 1000); return s.heightAt(x, z) - cfg.verticalDatum; }, normalAt(x, z, out) { const e = .1; const { Vector3 } = globalThis; return (out ?? new Vector3()).set(-(this.heightAt(x + e, z) - this.heightAt(x - e, z)) / (2 * e), 1, -(this.heightAt(x, z + e) - this.heightAt(x, z - e)) / (2 * e)).normalize(); } };
    globalThis.Vector3 = (await import('@babylonjs/core/Maths/math.vector.js')).Vector3;
    const roads = JSON.parse(readFileSync('public/roads/roads.json', 'utf8')).roads;
    const after = process.argv.includes('--after'), baseline = process.argv.includes('--baseline');
    let sampler = null;
    if (after || baseline) {
        await moduleFrom('src/world/road-surface.ts');
        await moduleFrom('src/road-visuals.ts');
        let source = readFileSync('src/road-draping.ts', 'utf8');
        if (baseline) {
            source = execFileSync('git', ['show', 'HEAD:src/road-draping.ts'], { encoding: 'utf8' });
            source = "import {createRenderedRoadSurface} from './world/road-surface';\n" + source;
            source = source.replace('pushVertex(x, y, z, terrain.normalAt(x, z, scratch), ROLE_PAVEMENT, tint);', 'pushVertex(x, y, z, terrain.normalAt(x, z, scratch), 4, tint);')
                .replace('pushVertex(x, terrain.heightAt(x, z) + offset, z, terrain.normalAt(x, z, scratch), ROLE_PAVEMENT, tint);', 'pushVertex(x, terrain.heightAt(x, z) + offset, z, terrain.normalAt(x, z, scratch), 4, tint);');
            source = source.replace('    meshes,\n    stats,', '    meshes,\n    surface: createRenderedRoadSurface(surface, CLASSES.map((cls) => ({ class: cls, ...typed[cls] }))),\n    stats,');
        }
        const { loadRoadNetwork } = await moduleFrom('src/road-draping.ts', source);
        const { NullEngine } = await import('@babylonjs/core/Engines/nullEngine.js');
        const { Scene } = await import('@babylonjs/core/scene.js');
        const engine = new NullEngine();
        const scene = new Scene(engine);
        const network = await loadRoadNetwork(scene, terrain, { fetchImpl: async () => ({ ok: true, json: async () => ({ roads }) }) });
        sampler = network.surface;
    }
    const values = { ROAD: [], TRACK: [], PATH: [] };
    for (const road of roads) {
        let previous = null;
        for (let i = 1; i < road.points.length; i++) {
            const a = road.points[i - 1], b = road.points[i], len = Math.hypot(b[0] - a[0], b[1] - a[1]);
            if (len < .01)
                continue;
            const n = Math.ceil(len / 1), dx = (b[0] - a[0]) / len, dz = (b[1] - a[1]) / len;
            for (let j = 0; j <= n; j++) {
                const x = a[0] + (b[0] - a[0]) * j / n, z = a[1] + (b[1] - a[1]) * j / n;
                const h = (x, z) => (after || baseline) ? sampler.heightAt(x, z) : terrain.heightAt(x, z);
                const contact=sampler?.sampleAt(x,z);
                const longitudinalSlope = contact?-(contact.normal.x*dx+contact.normal.z*dz)/contact.normal.y:(h(x + dx * .5, z + dz * .5) - h(x - dx * .5, z - dz * .5));
                const crossSlope = contact?(contact.normal.x*dz-contact.normal.z*dx)/contact.normal.y:(h(x - dz * road.width * .4, z + dx * road.width * .4) - h(x + dz * road.width * .4, z - dx * road.width * .4)) / (road.width * .8);
                const y = h(x, z);
                const dist = previous ? Math.hypot(x - previous.x, z - previous.z) : 0;
                const normal = (sampler ?? terrain).normalAt(x, z);
                const normalDeltaPerMeter = previous && dist > .001 ? Math.acos(Math.max(-1, Math.min(1, normal.x * previous.normal.x + normal.y * previous.normal.y + normal.z * previous.normal.z))) / dist : 0;
                const sample = { normalDeltaPerMeter, id: road.id, x, z, height: y, longitudinalSlope, crossSlope, heightDeltaPerMeter: dist > .001 ? Math.abs(y - previous.y) / dist : 0, slopeDerivative: dist > .001 ? Math.abs(longitudinalSlope - previous.s) / dist : 0 };
                values[road.class].push(sample);
                previous = { x, z, y, s: longitudinalSlope, normal };
            }
        }
    }
    const report = { mode: after ? 'actual final ribbon triangles AFTER' : baseline ? 'HEAD ribbon triangles BEFORE' : 'real triangular MDT', classes: {} };
    for (const [cls, rows] of Object.entries(values)) {
        const metrics = {};
        for (const key of ['longitudinalSlope', 'crossSlope', 'heightDeltaPerMeter', 'slopeDerivative', 'normalDeltaPerMeter']) {
            const sorted = rows.map(r => Math.abs(r[key])).sort((a, b) => a - b);
            metrics[key] = { p50: sorted[Math.floor(sorted.length * .5)], p95: sorted[Math.floor(sorted.length * .95)], p99: sorted[Math.floor(sorted.length * .99)], max: sorted.at(-1), worst: rows.slice().sort((a, b) => Math.abs(b[key]) - Math.abs(a[key])).slice(0, 5) };
        }
        report.classes[cls] = { count: rows.length, metrics, maxHeightDeltaPerMeter: metrics.heightDeltaPerMeter.max, maxCrossSlope: metrics.crossSlope.max, maxSlopeDerivative: metrics.slopeDerivative.max };
    }
    mkdirSync('outputs/road-surface-20260930', { recursive: true });
    writeFileSync(`outputs/road-surface-20260930/${after ? 'after' : baseline ? 'before' : 'mdt'}.json`, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(Object.fromEntries(Object.entries(report.classes).map(([k, v]) => [k, Object.fromEntries(Object.entries(v.metrics).map(([m, s]) => [m, { p95: s.p95, p99: s.p99, max: s.max }]))])), null, 2));
}
finally {
    for (const p of generated)
        rmSync(p, { force: true });
}
