#!/usr/bin/env node
/**
 * Busca y emite la PRIMERA RUTA jugable del proyecto:
 *
 *   Villafranca (asfalto) -> carretera -> entrada a pista -> pista con desnivel
 *   -> objetivo (fondo de pista), y vuelta por el mismo camino.
 *
 * POR QUE ES UN SCRIPT Y NO UNA RUTA ESCRITA A MANO
 * ------------------------------------------------
 * La ruta tiene que salir del grafo REAL de OSM (`public/roads/navigation.json`)
 * y de la pendiente REAL del terreno, no de una intuición mirando un mapa. Un
 * script además permite volver a derivarla y comprobar que sigue siendo válida
 * cuando cambie la red viaria o el terreno.
 *
 * LA ALTURA SALE DEL MISMO CODIGO QUE EL JUEGO
 * -------------------------------------------
 * Se transpila `src/heightfield.ts` y se llama a su `heightAt`. NO se reimplementa
 * la interpolación: reimplementarla es el error clásico de este proyecto (ver el
 * invariante de la diagonal SO->NE). Si el interpolador cambia, este script lo
 * sigue sin tocar una línea.
 *
 * OJO con las dos alturas: `createHeightfield().heightAt` devuelve metros
 * ABSOLUTOS; el mundo usa `y = absoluto − verticalDatum`. Acá se devuelve mundo.
 *
 * USO
 *   node scripts/gameplay/build_first_route.mjs           # informa y escribe
 *   node scripts/gameplay/build_first_route.mjs --check   # no escribe: verifica
 *   node scripts/gameplay/build_first_route.mjs --top 10  # muestra candidatas
 *
 * `--check` es lo que corre `npm test`: vuelve a derivar la ruta y falla si el
 * archivo commiteado no coincide, o si el trazado dejó de ser conducente.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');

const argv = process.argv.slice(2);
const CHECK = argv.includes('--check');
const TOP = Number((argv[argv.indexOf('--top') + 1] ?? '').trim()) || 6;

// ---------------------------------------------------------------- restricciones
// Margen del 4x4: la tracción limita a atan(grip) = atan(0.8) ≈ 38,7°, y la fuerza
// de motor a ~52°. Pero eso es el límite teórico: 20° es "se trepa sin sufrir".
const MAX_SLOPE_DEG = 20;
const TARGET_CLEAR_RADIUS_M = 18;
const TARGET_MAX_LOCAL_SLOPE_DEG = 12;
const MIN_ROAD_M = 250; // arranca en asfalto de verdad
const MIN_TRACK_M = 600; // y después hay pista de verdad
const MIN_LENGTH_M = 1100;
// 5-10 min de loop: ida y vuelta. A ~30 km/h de media en pista son ~2,2 km por
// tramo => ~9 min de conducción. Más largo no entra en el presupuesto de tiempo.
const MAX_LENGTH_M = 2100;
const MAX_PATH_FRACTION = 0.1; // PATH es senda: se cruza, no se conduce
const MIN_ASCENT_M = 60; // el desnivel es el motivo de ir en 4x4
// El objetivo no puede caer cerca del borde de la ventana: ahí el terreno se corta
// y se ve el fin del mundo.
const TARGET_BORDER_MARGIN_M = 350;

// ------------------------------------------------------------------- el heightfield real
const config = JSON.parse(readFileSync(resolve(root, 'public/terrain/config.json'), 'utf8'));
const DATUM = config.verticalDatum;
const tilesDir = resolve(root, 'public/terrain/tiles');
const tileDocs = readdirSync(tilesDir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(resolve(tilesDir, f), 'utf8')));

const tmp = mkdtempSync(resolve(here, '.route-tmp-'));
const text = ts.transpileModule(readFileSync(resolve(root, 'src/heightfield.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, verbatimModuleSyntax: false },
}).outputText;
writeFileSync(resolve(tmp, 'heightfield.gen.mjs'), text.replace(/(['"])(@babylonjs\/core\/[^'"]+)\1/g, '$1$2.js$1'));
const { createHeightfield, containsPoint, gridExtent } = await import(`file://${resolve(tmp, 'heightfield.gen.mjs')}`);
rmSync(tmp, { recursive: true, force: true });

const samplers = tileDocs.map((t) => ({ g: t.grid, hf: createHeightfield(t.grid, 1) }));
const extents = samplers.map((s) => gridExtent(s.g));

/** Altura de MUNDO en (x, z). Fuera de la ventana: se recorta al borde, no se inventa. */
function terrainY(x, z) {
  for (let i = 0; i < samplers.length; i++) {
    if (containsPoint(samplers[i].g, x, z)) return samplers[i].hf.heightAt(x, z) - DATUM;
  }
  let best = samplers[0];
  let bestD = Infinity;
  for (let i = 0; i < samplers.length; i++) {
    const e = extents[i];
    const cx = Math.min(Math.max(x, e.minX), e.maxX);
    const cz = Math.min(Math.max(z, e.minZ), e.maxZ);
    const d = (cx - x) ** 2 + (cz - z) ** 2;
    if (d < bestD) { bestD = d; best = samplers[i]; }
  }
  const e = gridExtent(best.g);
  return best.hf.heightAt(Math.min(Math.max(x, e.minX), e.maxX), Math.min(Math.max(z, e.minZ), e.maxZ)) - DATUM;
}

// Pendiente del terreno (grados) muestreando a `step` m alrededor.
function slopeAt(x, z, step) {
  const dx = (terrainY(x + step, z) - terrainY(x - step, z)) / (2 * step);
  const dz = (terrainY(x, z + step) - terrainY(x, z - step)) / (2 * step);
  return (Math.atan(Math.hypot(dx, dz)) * 180) / Math.PI;
}

// ------------------------------------------------------------------------- el grafo
const nav = JSON.parse(readFileSync(resolve(root, 'public/roads/navigation.json'), 'utf8'));
const roadsDoc = JSON.parse(readFileSync(resolve(root, 'public/roads/roads.json'), 'utf8'));
const spawn = roadsDoc.meta.spawn_world;
const NODES = nav.nodes;

const adj = NODES.map(() => []);
for (let k = 0; k < nav.edges.length; k++) {
  const [i, j] = nav.edges[k];
  const meta = nav.edgeMeta[k];
  const w = meta.length;
  adj[i].push({ to: j, w, meta, k });
  adj[j].push({ to: i, w, meta, k });
}

function nearestNode(x, z) {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < NODES.length; i++) {
    const d = (NODES[i][0] - x) ** 2 + (NODES[i][1] - z) ** 2;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

// Dijkstra con montículo binario mínimo. Devuelve dist y el predecesor.
function dijkstra(src) {
  const dist = new Float64Array(NODES.length).fill(Infinity);
  const prev = new Int32Array(NODES.length).fill(-1);
  const prevEdge = new Int32Array(NODES.length).fill(-1);
  const done = new Uint8Array(NODES.length);
  const heap = [[0, src]];
  dist[src] = 0;
  const push = (item) => {
    heap.push(item);
    let c = heap.length - 1;
    while (c > 0) {
      const p = (c - 1) >> 1;
      if (heap[p][0] <= heap[c][0]) break;
      [heap[p], heap[c]] = [heap[c], heap[p]];
      c = p;
    }
  };
  const pop = () => {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length > 0) {
      heap[0] = last;
      let p = 0;
      for (;;) {
        const l = 2 * p + 1;
        const r = l + 1;
        let m = p;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === p) break;
        [heap[p], heap[m]] = [heap[m], heap[p]];
        p = m;
      }
    }
    return top;
  };
  while (heap.length > 0) {
    const [d, u] = pop();
    if (done[u]) continue;
    done[u] = 1;
    for (const e of adj[u]) {
      const nd = d + e.w;
      if (nd < dist[e.to] - 1e-9) {
        dist[e.to] = nd;
        prev[e.to] = u;
        prevEdge[e.to] = e.k;
        push([nd, e.to]);
      }
    }
  }
  return { dist, prev, prevEdge };
}

const SRC = nearestNode(spawn[0], spawn[1]);
const { dist, prev, prevEdge } = dijkstra(SRC);

function pathTo(node) {
  const nodes = [];
  const edges = [];
  let cur = node;
  while (cur !== -1) {
    nodes.push(cur);
    if (prevEdge[cur] !== -1) edges.push(prevEdge[cur]);
    cur = prev[cur];
  }
  nodes.reverse();
  edges.reverse();
  return { nodes, edges };
}

/** Perfil de pendiente del trazado muestreando cada 5 m sobre la polilínea. */
function profile(points) {
  const STEP = 5;
  const samples = [];
  for (let i = 0; i + 1 < points.length; i++) {
    const [x0, z0] = points[i];
    const [x1, z1] = points[i + 1];
    const seg = Math.hypot(x1 - x0, z1 - z0);
    const n = Math.max(1, Math.round(seg / STEP));
    for (let s = 0; s < n; s++) {
      const t = s / n;
      samples.push([x0 + (x1 - x0) * t, z0 + (z1 - z0) * t]);
    }
  }
  samples.push(points[points.length - 1]);

  const slopes = [];
  let ascent = 0;
  let descent = 0;
  let prevY = null;
  for (const [x, z] of samples) {
    const y = terrainY(x, z);
    if (prevY !== null) {
      const d = y - prevY;
      if (d > 0) ascent += d;
      else descent -= d;
    }
    prevY = y;
    slopes.push(slopeAt(x, z, 4));
  }
  slopes.sort((a, b) => a - b);
  const q = (p) => slopes[Math.min(slopes.length - 1, Math.floor(p * slopes.length))];
  const over = slopes.filter((s) => s > MAX_SLOPE_DEG).length;

  let worst = 0;
  for (let i = 0; i + 5 <= slopes.length; i++) {
    const win = slopes.slice(i, i + 5);
    const avg = win.reduce((a, b) => a + b, 0) / win.length;
    if (avg > worst) worst = avg;
  }
  return {
    lengthM: 0,
    slopeP50Deg: q(0.5),
    slopeP95Deg: q(0.95),
    slopeMaxDeg: slopes[slopes.length - 1],
    stepsOver20Deg: over,
    worstRampDeg: worst,
    ascentM: ascent,
    descentM: descent,
  };
}

// ------------------------------------------------------------- candidatas a objetivo
// Distancia a la carretera más cercana, para que el objetivo se sienta lejos del asfalto.
const roadSamples = [];
for (let i = 0; i < NODES.length; i++) {
  for (const e of adj[i]) {
    if (e.meta.class === 'ROAD' && i < e.to) roadSamples.push(NODES[i], NODES[e.to]);
  }
}
function distToRoad(x, z) {
  let best = Infinity;
  for (let i = 0; i < roadSamples.length; i++) {
    const a = roadSamples[i];
    const bx = a[0] - x;
    const bz = a[1] - z;
    const d = bx * bx + bz * bz;
    if (d < best) best = d;
  }
  return Math.sqrt(best);
}

const candidates = [];
for (let node = 0; node < NODES.length; node++) {
  if (node === SRC || !Number.isFinite(dist[node])) continue;
  const total = dist[node];
  if (total < MIN_LENGTH_M || total > MAX_LENGTH_M * 1.15) continue;

  // Grado bajo = fondo de pista. Es donde tiene sentido poner una instalación.
  let degree = 0;
  for (const e of adj[node]) if (e.meta.class !== 'PATH') degree++;
  if (degree > 2) continue;

  const [tx, tz] = NODES[node];
  const win = roadsDoc.meta.window_m;
  const sizeE = win.e[1] - win.e[0];
  const sizeN = win.n[1] - win.n[0];
  if (
    tx < TARGET_BORDER_MARGIN_M ||
    tz < TARGET_BORDER_MARGIN_M ||
    tx > sizeE - TARGET_BORDER_MARGIN_M ||
    tz > sizeN - TARGET_BORDER_MARGIN_M
  ) {
    continue;
  }
  if (slopeAt(tx, tz, 8) > TARGET_MAX_LOCAL_SLOPE_DEG) continue;

  const { nodes, edges } = pathTo(node);
  let roadM = 0;
  let trackM = 0;
  let pathM = 0;
  for (const ei of edges) {
    const c = nav.edgeMeta[ei].class;
    const len = nav.edgeMeta[ei].length;
    if (c === 'ROAD') roadM += len;
    else if (c === 'TRACK') trackM += len;
    else pathM += len;
  }
  if (roadM < MIN_ROAD_M || trackM < MIN_TRACK_M) continue;
  if (pathM > total * MAX_PATH_FRACTION) continue;
  if (roadM > total * 0.6) continue; // si es casi todo asfalto, no es offroad

  // Primera transición ROAD -> TRACK: es la "entrada a pista".
  let entry = -1;
  for (let i = 1; i < edges.length; i++) {
    if (nav.edgeMeta[edges[i - 1]].class === 'ROAD' && nav.edgeMeta[edges[i]].class !== 'ROAD') {
      entry = nodes[i];
      break;
    }
  }
  if (entry < 0) continue;

  const pts = nodes.map((n) => NODES[n]);
  const pf = profile(pts);
  if (pf.ascentM < MIN_ASCENT_M) continue;
  if (pf.stepsOver20Deg > 6) continue; // tramos puntuales sí, un muro no

  const dRoad = distToRoad(tx, tz);
  const score = 3 * pf.ascentM + 2 * (trackM / 1000) + 1.5 * (dRoad / 1000) + (pf.slopeMaxDeg < 12 ? 25 : 0);
  candidates.push({ node, total, roadM, trackM, pathM, entry, pf, dRoad, score, pts, nodes, edges });
}

candidates.sort((a, b) => b.score - a.score);

console.log(`=== candidatas (top ${TOP}) ===`);
for (const c of candidates.slice(0, TOP)) {
  console.log(
    `  score ${c.score.toFixed(1).padStart(6)} | ${(c.total / 1000).toFixed(2)} km | ROAD ${c.roadM.toFixed(0)} TRACK ${c.trackM.toFixed(0)} PATH ${c.pathM.toFixed(0)} | asc ${c.pf.ascentM.toFixed(0)} m desc ${c.pf.descentM.toFixed(0)} m | pend p95 ${c.pf.slopeP95Deg.toFixed(1)}° max ${c.pf.slopeMaxDeg.toFixed(1)}° | >20° ${c.pf.stepsOver20Deg} | a carretera ${c.dRoad.toFixed(0)} m | objetivo (${NODES[c.node][0].toFixed(0)}, ${NODES[c.node][1].toFixed(0)})`,
  );
}

if (candidates.length === 0) {
  console.error('\nSin candidatas: revisá las restricciones. NO se escribe nada.');
  process.exit(1);
}

const best = candidates[0];

// --------------------------------------------------------------- simplificación
// Ramer-Douglas-Peucker: se guardan los puntos que doblan de verdad. Los checkpoints
// son pocos y con significado, no cada vértice del grafo.
function rdp(points, eps) {
  if (points.length <= 2) return points.slice();
  const [ax, az] = points[0];
  const [bx, bz] = points[points.length - 1];
  const dx = bx - ax;
  const dz = bz - az;
  const len = Math.hypot(dx, dz) || 1;
  let maxD = -1;
  let idx = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const [px, pz] = points[i];
    const d = Math.abs(dz * (px - ax) - dx * (pz - az)) / len;
    if (d > maxD) { maxD = d; idx = i; }
  }
  if (maxD <= eps) return [points[0], points[points.length - 1]];
  return [...rdp(points.slice(0, idx + 1), eps).slice(0, -1), ...rdp(points.slice(idx), eps)];
}

const STEP_LEG = 5;
// La entrada a pista es un checkpoint de misión: se fuerza dentro de los waypoints
// aunque la simplificación la hubiera descartado. Filtrar el trazado completo por
// un conjunto conserva el orden del recorrido.
const junctionIdx = best.nodes.indexOf(best.entry);
const keepSet = new Set(rdp(best.pts, 12));
keepSet.add(best.pts[junctionIdx]);
const kept = best.pts.filter((p) => keepSet.has(p));
const start = { x: NODES[SRC][0], z: NODES[SRC][1] };
const startYaw = Math.atan2(best.pts[1][0] - start.x, best.pts[1][1] - start.z);

// Puntos de paso: se recorre el trazado COMPLETO y se anota cada vértice que
// sobrevivió a la simplificación (comparación por referencia: `rdp` devuelve los
// mismos objetos), con su rol, su clase de vía y su distancia acumulada real.
const legs = best.edges.map((ei) => nav.edgeMeta[ei].class);
const waypoints = [];
let acc = 0;
let k = 0;
for (let i = 0; i < best.pts.length; i++) {
  if (i > 0) acc += Math.hypot(best.pts[i][0] - best.pts[i - 1][0], best.pts[i][1] - best.pts[i - 1][1]);
  if (k >= kept.length || best.pts[i] !== kept[k]) continue;
  const leg = i === 0 ? legs[0] : legs[Math.min(i - 1, legs.length - 1)];
  const role =
    i === 0
      ? 'start'
      : i === best.pts.length - 1
        ? 'target'
        : best.nodes[i] === best.entry
          ? 'junction'
          : leg === 'ROAD'
            ? 'road'
            : 'track';
  waypoints.push({ x: best.pts[i][0], z: best.pts[i][1], role, leg, atM: Math.round(acc) });
  k++;
}

const target = { x: NODES[best.node][0], z: NODES[best.node][1] };
const entryPoint = { x: NODES[best.entry][0], z: NODES[best.entry][1] };
// La instalación mira hacia el valle: hacia el pueblo, que es de donde se viene.
const targetYaw = Math.atan2(start.x - target.x, start.z - target.z);

const sourceSha256 = createHash('sha256').update(readFileSync(resolve(root, 'public/roads/navigation.json'))).digest('hex');

const route = {
  id: 'villafranca-pista-objetivo',
  name: 'Repetidor sin señal',
  generatedBy: 'scripts/gameplay/build_first_route.mjs',
  sourceSha256,
  start: { x: Math.round(start.x * 100) / 100, z: Math.round(start.z * 100) / 100 },
  startYaw: Math.round(startYaw * 1e6) / 1e6,
  waypoints,
  trackEntry: { x: Math.round(entryPoint.x * 100) / 100, z: Math.round(entryPoint.z * 100) / 100 },
  target: { x: Math.round(target.x * 100) / 100, z: Math.round(target.z * 100) / 100 },
  targetYaw: Math.round(targetYaw * 1e6) / 1e6,
  targetClearRadiusM: TARGET_CLEAR_RADIUS_M,
  returnPoint: { x: Math.round(start.x * 100) / 100, z: Math.round(start.z * 100) / 100 },
  checkpoints: [
    { id: 'start', label: 'Villafranca Montes de Oca', x: Math.round(start.x * 100) / 100, z: Math.round(start.z * 100) / 100, atM: 0 },
    { id: 'junction', label: 'Dejar la carretera', x: Math.round(entryPoint.x * 100) / 100, z: Math.round(entryPoint.z * 100) / 100, atM: Math.round(waypoints.find((w) => w.role === 'junction')?.atM ?? 0) },
    { id: 'track-entry', label: 'Entrada a la pista', x: Math.round(entryPoint.x * 100) / 100, z: Math.round(entryPoint.z * 100) / 100, atM: Math.round(waypoints.find((w) => w.role === 'junction')?.atM ?? 0) },
    { id: 'target', label: 'Repetidor', x: Math.round(target.x * 100) / 100, z: Math.round(target.z * 100) / 100, atM: Math.round(best.total) },
    { id: 'return', label: 'Regreso a Villafranca', x: Math.round(start.x * 100) / 100, z: Math.round(start.z * 100) / 100, atM: Math.round(best.total) },
  ],
  profile: {
    lengthM: Math.round(best.total),
    roadM: Math.round(best.roadM),
    trackM: Math.round(best.trackM),
    pathM: Math.round(best.pathM),
    ascentM: Math.round(best.pf.ascentM),
    descentM: Math.round(best.pf.descentM),
    slopeP50Deg: Math.round(best.pf.slopeP50Deg * 10) / 10,
    slopeP95Deg: Math.round(best.pf.slopeP95Deg * 10) / 10,
    slopeMaxDeg: Math.round(best.pf.slopeMaxDeg * 10) / 10,
    stepsOver20Deg: best.pf.stepsOver20Deg,
    worstRampDeg: Math.round(best.pf.worstRampDeg * 10) / 10,
  },
};

const render = (value, indent) => {
  const pad = ' '.repeat(indent);
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const items = value.map((v) => `${pad}  ${render(v, indent + 2)}`).join(',\n');
    return `[\n${items},\n${pad}]`;
  }
  if (value !== null && typeof value === 'object') {
    const items = Object.entries(value).map(([k, v]) => `${pad}  ${k}: ${render(v, indent + 2)}`).join(',\n');
    return `{\n${items},\n${pad}}`;
  }
  return typeof value === 'string' ? `'${value}'` : String(value);
};

const body = `// GENERADO POR scripts/gameplay/build_first_route.mjs — NO EDITAR A MANO.
// Se regenera con: node scripts/gameplay/build_first_route.mjs
// Verificado por: npm test (modo --check).
//
// Ruta: ${route.name}
// ${route.profile.lengthM} m en planta · ROAD ${route.profile.roadM} m · TRACK ${route.profile.trackM} m
// Desnivel: +${route.profile.ascentM} m / -${route.profile.descentM} m · pendiente máx ${route.profile.slopeMaxDeg}°
// Origen de la red: navigation.json sha256 ${sourceSha256.slice(0, 16)}…
import type { FirstRoute } from './route-types';

export const FIRST_ROUTE: FirstRoute = ${render(route, 0)};
`;

const outPath = resolve(root, 'src/gameplay/first-route.ts');
const previous = (() => {
  try { return readFileSync(outPath, 'utf8'); } catch { return null; }
})();

console.log('\n=== ruta elegida ===');
console.log(`  ${route.name} · ${route.profile.lengthM} m · asc ${route.profile.ascentM} m · pend máx ${route.profile.slopeMaxDeg}°`);
console.log(`  inicio (${route.start.x}, ${route.start.z}) yaw ${route.startYaw}`);
console.log(`  entrada a pista (${route.trackEntry.x}, ${route.trackEntry.z}) a ${route.checkpoints[2].atM} m`);
console.log(`  objetivo (${route.target.x}, ${route.target.z}) yaw ${route.targetYaw}`);
console.log(`  waypoints ${waypoints.length}`);

{
  const seq = [];
  for (const w of waypoints) if (seq[seq.length - 1] !== w.leg) seq.push(w.leg);
  console.log(`  secuencia de vías: ${seq.join(' -> ')}`);
  for (const w of waypoints) {
    console.log(`    ${String(w.atM).padStart(5)} m  ${w.role.padEnd(8)} ${w.leg.padEnd(5)} (${w.x.toFixed(0)}, ${w.z.toFixed(0)})`);
  }
  const yInicio = terrainY(start.x, start.z);
  const yObjetivo = terrainY(target.x, target.z);
  console.log(`  cota de mundo: inicio ${yInicio.toFixed(1)} m · objetivo ${yObjetivo.toFixed(1)} m · delta ${(yObjetivo - yInicio).toFixed(1)} m`);
}

if (CHECK) {
  if (previous === null) {
    console.error('\nFALLA --check: no existe src/gameplay/first-route.ts');
    process.exit(1);
  }
  if (previous !== body) {
    console.error('\nFALLA --check: el archivo commiteado NO coincide con la ruta derivada.');
    console.error('  Regeneralo con: node scripts/gameplay/build_first_route.mjs');
    process.exit(1);
  }
  if (route.profile.slopeMaxDeg > MAX_SLOPE_DEG && route.profile.stepsOver20Deg > 6) {
    console.error('\nFALLA --check: el trazado dejó de ser conducente.');
    process.exit(1);
  }
  console.log('  OK  el archivo coincide con la derivación y el trazado es conducente');
} else {
  writeFileSync(outPath, body);
  console.log(`\n  escrito: ${outPath} (${previous === body ? 'sin cambios' : 'actualizado'})`);
}
