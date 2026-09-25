// Análisis desechable: ¿cuánta superficie hay por clase y a qué distancia de la ruta?
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = '/home/kiri_/projects/montes-de-oca-offroad';
const cfg = JSON.parse(readFileSync(resolve(root, 'public/terrain/config.json'), 'utf8'));
const W = (g) => [
  (g.lon - cfg.origin.lon) * cfg.projection.metersPerDegreeLon,
  (g.lat - cfg.origin.lat) * cfg.projection.metersPerDegreeLat,
];

const tmp = mkdtempSync(resolve(root, 'scripts/environment/.ana-'));
const text = ts.transpileModule(readFileSync(resolve(root, 'src/gameplay/first-route.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, verbatimModuleSyntax: false },
}).outputText.replace(/(['"])\.\/route-types\1/g, '$1./route-types.gen.mjs$1');
writeFileSync(resolve(tmp, 'route.gen.mjs'), text);
const { FIRST_ROUTE } = await import(`file://${resolve(tmp, 'route.gen.mjs')}`);
rmSync(tmp, { recursive: true, force: true });

const data = JSON.parse(readFileSync(resolve(root, 'data/gameplay/raw/osm_landcover_window.json'), 'utf8'));
const classify = (t) =>
  !t ? null : t.landuse === 'forest' || t.natural === 'wood' ? 'FOREST'
  : t.natural === 'grassland' || t.natural === 'scrub' || t.landuse === 'meadow' ? 'GRASS'
  : t.landuse === 'farmland' ? 'FIELDS' : null;
const same = (a, b) => Math.abs(a.lat - b.lat) < 1e-9 && Math.abs(a.lon - b.lon) < 1e-9;
function chain(ms) {
  const open = ms.filter((m) => m.geometry && m.geometry.length >= 2).map((m) => m.geometry.slice());
  const rings = [];
  while (open.length) {
    let cur = open.pop();
    let grew = true;
    while (grew && !same(cur[0], cur[cur.length - 1])) {
      grew = false;
      for (let i = 0; i < open.length; i++) {
        const c = open[i];
        const h = cur[cur.length - 1], t = cur[0];
        if (same(h, c[0])) cur = cur.concat(c.slice(1));
        else if (same(h, c[c.length - 1])) cur = cur.concat(c.slice(0, -1).reverse());
        else if (same(t, c[c.length - 1])) cur = c.slice(0, -1).concat(cur);
        else if (same(t, c[0])) cur = c.slice().reverse().concat(cur.slice(1));
        else continue;
        open.splice(i, 1);
        grew = true;
        break;
      }
    }
    if (cur.length >= 3) rings.push(cur);
  }
  return rings;
}
const mem = new Set();
for (const e of data.elements) if (e.type === 'relation') for (const m of e.members || []) if (m.type === 'way') mem.add(m.ref);
const polys = { FOREST: [], GRASS: [], FIELDS: [] };
for (const el of [...data.elements].sort((a, b) => (a.type === b.type ? a.id - b.id : a.type === 'way' ? -1 : 1))) {
  const cls = classify(el.tags);
  if (!cls) continue;
  if (el.type === 'way') {
    const g = el.geometry || [];
    if (g.length < 3) continue;
    const closed = Math.abs(g[0].lat - g[g.length - 1].lat) < 1e-12 && Math.abs(g[0].lon - g[g.length - 1].lon) < 1e-12;
    if (!closed && mem.has(el.id)) continue;
    polys[cls].push({ id: el.id, rings: [g.map(W)] });
  } else {
    const o = (el.members || []).filter((m) => m.type === 'way' && m.role !== 'inner');
    const inn = (el.members || []).filter((m) => m.type === 'way' && m.role === 'inner');
    const r = [...chain(o), ...chain(inn)].map((ring) => ring.map(W));
    if (r.length) polys[cls].push({ id: 1e12 + el.id, rings: r });
  }
}
const inside = (x, z, rings) => {
  let ins = false;
  for (const ring of rings)
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const az = ring[j][1], bz = ring[i][1];
      if (az > z !== bz > z) {
        const t = (z - az) / (bz - az);
        if (x < ring[j][0] + t * (ring[i][0] - ring[j][0])) ins = !ins;
      }
    }
  return ins;
};

// ruta: distancias acumuladas
const poly = FIRST_ROUTE.polyline;
const segs = [];
for (let i = 1; i < poly.length; i++) segs.push([poly[i - 1], poly[i]]);
const distToRoute = (x, z) => {
  let best = 2500;
  for (const [a, b] of segs) {
    const dx = b.x - a.x, dz = b.z - a.z;
    const l2 = dx * dx + dz * dz;
    let t = l2 > 0 ? ((x - a.x) * dx + (z - a.z) * dz) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const ex = a.x + t * dx - x, ez = a.z + t * dz - z;
    const d = Math.sqrt(ex * ex + ez * ez);
    if (d < best) best = d;
  }
  return best;
};

const STEP = 20;
const bands = [150, 300, 600, 1000, 2000, 6000];
const area = {};
for (const cls of Object.keys(polys)) {
  area[cls] = new Array(bands.length + 1).fill(0);
  const cellArea = STEP * STEP;
  for (let z = STEP / 2; z < 6000; z += STEP) {
    for (let x = STEP / 2; x < 6000; x += STEP) {
      let hit = false;
      for (const p of polys[cls]) {
        const b = p.rings;
        if (inside(x, z, b)) { hit = true; break; }
      }
      if (!hit) continue;
      const d = distToRoute(x, z);
      let k = bands.findIndex((b) => d <= b);
      if (k < 0) k = bands.length;
      area[cls][k] += cellArea;
    }
  }
}
console.log('bandas de distancia (m):', bands.join(' | '));
for (const [cls, arr] of Object.entries(area)) {
  console.log(cls.padEnd(8), arr.map((v) => `${(v / 1e6).toFixed(3)} km²`).join('  '), ' total', (arr.reduce((a, b) => a + b) / 1e6).toFixed(3));
}
const total = Object.values(area).reduce((a, arr) => a + arr.reduce((x, y) => x + y, 0), 0);
console.log('total sembrable', (total / 1e6).toFixed(3), 'km² de 36');
