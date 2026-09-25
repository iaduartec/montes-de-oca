// Comparador campo por campo: publicado_d1.json vs reproduccion/roads_draping.json.
// Uso: node output/draping_verify/compare_draping.mjs [pub] [rep]
import { readFileSync } from 'node:fs';

const [, , pubPath = 'output/draping_verify/publicado_d1.json',
  repPath = 'output/draping_verify/reproduccion/roads_draping.json'] = process.argv;

const pub = JSON.parse(readFileSync(pubPath, 'utf8'));
const rep = JSON.parse(readFileSync(repPath, 'utf8'));

const rows = [];
function walk(a, b, path) {
  const ta = a === null ? 'null' : Array.isArray(a) ? 'array' : typeof a;
  const tb = b === null ? 'null' : Array.isArray(b) ? 'array' : typeof b;
  if (ta !== tb) { rows.push({ path, pub: `(${ta}) ${JSON.stringify(a)}`, rep: `(${tb}) ${JSON.stringify(b)}`, delta: 'TYPE-MISMATCH' }); return; }
  if (ta === 'object') {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of [...keys].sort()) walk(a[k], b[k], path ? `${path}.${k}` : k);
    return;
  }
  if (ta === 'array') {
    if (a.length !== b.length) rows.push({ path: `${path}.length`, pub: a.length, rep: b.length, delta: b.length - a.length });
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) walk(a[i], b[i], `${path}[${i}]`);
    return;
  }
  if (ta === 'number') {
    const d = b - a;
    rows.push({ path, pub: a, rep: b, delta: d, num: true });
    return;
  }
  if (JSON.stringify(a) !== JSON.stringify(b)) rows.push({ path, pub: JSON.stringify(a), rep: JSON.stringify(b), delta: 'DIFF' });
}
walk(pub, rep, '');

const fmt = (v) => typeof v === 'number' ? (Math.abs(v) >= 1e-4 && Math.abs(v) < 1e7 ? String(v) : v.toExponential(6)) : String(v);
const pad = (s, n) => String(s).padEnd(n);

let mism = 0, same = 0;
const out = [];
out.push(pad('campo', 52) + pad('publicado', 24) + pad('reproducido', 24) + pad('delta', 20));
out.push('-'.repeat(120));
for (const r of rows) {
  const exact = r.num ? r.delta === 0 : r.delta === undefined;
  if (exact) same++; else mism++;
  if (!exact || r.num) out.push(pad(r.path, 52) + pad(fmt(r.pub), 24) + pad(fmt(r.rep), 24) + pad(fmt(r.delta), 20));
}
out.push('-'.repeat(120));
out.push(`hojas numéricas: ${rows.filter((r) => r.num).length} · exactas: ${rows.filter((r) => r.num && r.delta === 0).length} · distintas: ${rows.filter((r) => r.num && r.delta !== 0).length}`);
out.push(`no-numéricas: ${rows.filter((r) => !r.num).length} · iguales: ${rows.filter((r) => !r.num && r.delta === undefined).length} · distintas: ${rows.filter((r) => !r.num && r.delta !== undefined).length}`);
console.log(out.join('\n'));

// Claves presentes en uno y no en el otro (raíz y sub-objetos)
const onlyPub = [], onlyRep = [];
function keysOnly(a, b, path) {
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a)) {
    for (const k of Object.keys(a)) if (!(k in b)) onlyPub.push(path ? `${path}.${k}` : k);
    for (const k of Object.keys(b)) if (!(k in a)) onlyRep.push(path ? `${path}.${k}` : k);
    for (const k of Object.keys(a)) if (k in b) keysOnly(a[k], b[k], path ? `${path}.${k}` : k);
  }
}
keysOnly(pub, rep, '');
if (onlyPub.length || onlyRep.length) {
  console.log('\nClaves solo en publicado:', onlyPub.join(', ') || '(ninguna)');
  console.log('Claves solo en reproducido:', onlyRep.join(', ') || '(ninguna)');
}
