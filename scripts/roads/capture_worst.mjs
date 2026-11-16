// Captures the ten worst baseline road-surface samples from matching cameras.
// Run before against the pinned baseline server, then after against the new server.
// Example: node scripts/roads/capture_worst.mjs --phase before --base http://127.0.0.1:4194
//          node scripts/roads/capture_worst.mjs --phase after --base http://127.0.0.1:4193
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const arg = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const phase = arg('--phase', null);
const base = arg('--base', 'http://127.0.0.1:4193').replace(/\/$/, '');
const outDir = resolve(arg('--out-dir', 'outputs/road-v3-20261001'));
const sourceReport = resolve(arg('--baseline-json', `${outDir}/rendered-before.json`));
const camerasFile = resolve(arg('--cameras', `${outDir}/worst-cameras.json`));
const session = 'road-worst';
const prepareOnly = args.includes('--prepare-only');
if (phase !== 'before' && phase !== 'after') throw new Error('Usa --phase before|after');
mkdirSync(outDir, { recursive: true });

function baselineCameras() {
  const report = JSON.parse(readFileSync(sourceReport, 'utf8'));
  const candidates = new Map();
  const keys = ['longitudinalSlope', 'crossSlope', 'sourceBranchCrossSlope', 'ownFacetBank', 'centerlineFiniteSlope', 'crossSectionSlope', 'heightDeltaPerMeter', 'slopeDerivative', 'normalDeltaPerMeter'];
  for (const [className, group] of Object.entries(report.classes)) {
    for (const key of keys) {
      for (const sample of group.metrics[key]?.top10 ?? []) {
        const id = `${className}/${sample.id}/${sample.chainageM.toFixed(3)}`;
        const severity = Math.max(...keys.map(metric => Math.abs(sample[metric] ?? 0)));
        const entry = candidates.get(id) ?? { id, sample, metrics: [], severity: 0 };
        entry.metrics.push(key);
        entry.severity = Math.max(entry.severity, severity);
        candidates.set(id, entry);
      }
    }
  }
  const distinct = [];
  for (const entry of [...candidates.values()].sort((a, b) => b.severity - a.severity)) {
    if (distinct.some(other => Math.hypot(other.sample.x-entry.sample.x,other.sample.z-entry.sample.z)<25)) continue;
    distinct.push(entry); if (distinct.length===10) break;
  }
  return distinct.map((entry, index) => {
    const p = entry.sample;
    const dx = p.tangentX ?? 0, dz = p.tangentZ ?? 1;
    const yaw = Math.atan2(dx, dz);
    const query = new URLSearchParams({
      px: String(p.x - dx * 10), py: String(p.height + 20), pz: String(p.z - dz * 10),
      tx: String(p.x), ty: String(p.height), tz: String(p.z),
      vx: String(p.x), vz: String(p.z), vyaw: String(yaw), player: '0',
    });
    return { name: `worst_${String(index + 1).padStart(2, '0')}`, id: entry.id, severity: entry.severity, metrics: [...new Set(entry.metrics)], sample: p, query: query.toString() };
  });
}

let cameras;
if (phase === 'before') {
  if (!existsSync(sourceReport)) throw new Error(`Falta reporte baseline: ${sourceReport}`);
  cameras = baselineCameras();
  writeFileSync(camerasFile, JSON.stringify(cameras, null, 2));
} else {
  if (!existsSync(camerasFile)) throw new Error(`Faltan cámaras fijas de baseline: ejecuta primero --phase before (${camerasFile})`);
  cameras = JSON.parse(readFileSync(camerasFile, 'utf8'));
}

if (prepareOnly) {
  console.log(`Prepared ${cameras.length} fixed cameras at ${camerasFile}; no browser was launched.`);
} else {
const run = (...command) => execFileSync('agent-browser', ['--session', session, ...command], {
  encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 180_000,
}).trim();
const evaluate = expression => {
  const value = JSON.parse(run('eval', `JSON.stringify(${expression})`));
  return typeof value === 'string' ? JSON.parse(value) : value;
};

const report = { phase, base, sourceReport, cameras: camerasFile, captures: [] };
for (const camera of cameras) {
  run('open', `${base}/?${camera.query}`);
  run('wait', '--fn', '!!window.__game?.roads && !!window.__game?.terrainHeightAt');
  run('wait', '2200');
  const observed = evaluate(`(()=>{const g=window.__game,p=${JSON.stringify(camera.sample)};return {url:location.href,road:g.roads.sampleAt?.(p.x,p.z)??null,terrainHeight:g.terrainHeightAt(p.x,p.z),perf:g.perf()};})()`);
  const image = resolve(outDir, `${phase}_${camera.name}.png`);
  run('screenshot', image);
  report.captures.push({ name: camera.name, id: camera.id, baselineMetrics: camera.metrics, baselineSample: camera.sample, image, observed });
  console.log(`${phase} ${camera.name} ${camera.id} ${image}`);
}
const reportFile = resolve(outDir, `${phase}_worst_report.json`);
writeFileSync(reportFile, JSON.stringify(report, null, 2));
console.log(reportFile);
}
