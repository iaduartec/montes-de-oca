// Test de la misión "Repetidor sin señal", en Node y SIN Babylon.
//
// Por qué transpila en vez de reimplementar: la máquina de estados es la fuente
// de verdad; el test tiene que correr EL MISMO código que el juego, no una copia.
// Se usa el patrón exacto de `scripts/terrain/validate_terrain.mjs` (y de
// `build_first_route.mjs`): `ts.transpileModule` + import dinámico.
//
// Además de la misión se prueba el `interactor` (también puro): si no se prueba
// acá, no se prueba en ningún lado.
//
// Uso: node scripts/gameplay/test_mission.mjs
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');

let pass = 0;
const fails = [];
function check(name, ok, detail = '') {
  if (ok) {
    pass++;
    console.log(`[OK  ] ${name}${detail ? ' — ' + detail : ''}`);
  } else {
    fails.push(name);
    console.log(`[FALLA] ${name}${detail ? ' — ' + detail : ''}`);
  }
}

/** Traza legible de un snapshot. Se imprime en cada paso, no sólo "OK". */
function trace(label, s) {
  console.log(
    `  · ${label.padEnd(18)} state=${s.state.padEnd(14)} ` +
      `hint="${s.hint}"  dTarget=${s.distanceToTargetM.toFixed(1)}  ` +
      `dReturn=${s.distanceToReturnM.toFixed(1)}  repair=${s.repairProgress.toFixed(2)}  ` +
      `elapsed=${s.elapsedS.toFixed(2)}s`,
  );
}

// ---------------------------------------------------------------- transpilación
const tmp = mkdtempSync(resolve(here, '.mission-tmp-'));
function gen(rel, out) {
  const text = ts.transpileModule(readFileSync(resolve(root, rel), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, verbatimModuleSyntax: false },
  }).outputText;
  writeFileSync(resolve(tmp, out), text);
}
gen('src/gameplay/first-route.ts', 'first-route.gen.mjs');
gen('src/gameplay/mission.ts', 'mission.gen.mjs');
gen('src/gameplay/interact.ts', 'interact.gen.mjs');

const { FIRST_ROUTE } = await import(`file://${resolve(tmp, 'first-route.gen.mjs')}`);
const { createMission, MISSION_NAME } = await import(`file://${resolve(tmp, 'mission.gen.mjs')}`);
const { createInteractor } = await import(`file://${resolve(tmp, 'interact.gen.mjs')}`);
rmSync(tmp, { recursive: true, force: true });

const START = FIRST_ROUTE.start;
const TARGET = FIRST_ROUTE.target;
const RETURN = FIRST_ROUTE.returnPoint;
const DT = 1 / 60;

function ctx(x, z, over = {}) {
  return { x, z, driving: false, onFoot: true, interact: false, dt: DT, ...over };
}

console.log(`\n=== ruta real: ${FIRST_ROUTE.name} ===`);
console.log(`inicio (${START.x}, ${START.z}) · objetivo (${TARGET.x}, ${TARGET.z}) · regreso (${RETURN.x}, ${RETURN.z})`);

// ==========================================================================
console.log('\n=== A. flujo feliz completo ===');
const m = createMission(FIRST_ROUTE, { reachRadiusM: 25, repairSeconds: 2 });

check('nombre de misión es "REPETIDOR SIN SEÑAL"', MISSION_NAME === 'REPETIDOR SIN SEÑAL', MISSION_NAME);
check('nombre en snapshot coincide', m.snapshot.name === MISSION_NAME, m.snapshot.name);
check('arranca NOT_STARTED', m.snapshot.state === 'NOT_STARTED', m.snapshot.state);
trace('inicio', m.snapshot);

let s = m.update(ctx(START.x, START.z));
check('a pie en el inicio sigue NOT_STARTED', s.state === 'NOT_STARTED', s.state);
trace('pie-en-inicio', s);

s = m.update(ctx(START.x, START.z, { driving: true, onFoot: false }));
check('entrar al 4x4 -> ACTIVE', s.state === 'ACTIVE', s.state);
check('el reloj arranca en ACTIVE (elapsed > 0)', s.elapsedS > 0, `${s.elapsedS.toFixed(3)} s`);
trace('entra-4x4', s);

const mid = FIRST_ROUTE.waypoints[5]; // tramo de pista
s = m.update(ctx(mid.x, mid.z, { driving: true, onFoot: false }));
check('a mitad de pista sigue ACTIVE', s.state === 'ACTIVE', s.state);
check('hint de ACTIVE apunta al repetidor', s.hint === 'Seguí la pista hasta el repetidor', s.hint);
trace('pista-media', s);

s = m.update(ctx(TARGET.x, TARGET.z, { driving: true, onFoot: false }));
check('llegar al objetivo (a <= 25 m) -> TARGET_REACHED', s.state === 'TARGET_REACHED', s.state);
check('hint conduciendo pide bajar', s.hint === 'Bajá del 4x4 (F) y acercate', s.hint);
check('llegar NO repara solo', s.repaired === false && s.repairProgress === 0, `repair=${s.repairProgress}`);
trace('llega-objetivo', s);

// ---------- camino negativo: reparar desde el coche NO vale ----------
for (let i = 0; i < 180; i++) {
  s = m.update(ctx(TARGET.x, TARGET.z, { driving: true, onFoot: false, interact: true }));
}
check('E desde el coche 3 s NO repara (sigue TARGET_REACHED)', s.state === 'TARGET_REACHED', s.state);
check('progreso desde el coche = 0', s.repairProgress === 0, `${s.repairProgress}`);
trace('E-desde-coche', s);

// ---------- camino negativo: dt = 0 ----------
s = m.update(ctx(TARGET.x, TARGET.z, { driving: false, onFoot: true, interact: true, dt: 0 }));
check('dt=0 no rompe ni avanza el progreso', s.state === 'TARGET_REACHED' && s.repairProgress === 0, `repair=${s.repairProgress}`);
s = m.update(ctx(TARGET.x, TARGET.z, { driving: false, onFoot: true, interact: true, dt: Number.NaN }));
check('dt=NaN tampoco avanza', s.state === 'TARGET_REACHED' && s.repairProgress === 0, `repair=${s.repairProgress}`);
trace('dt-cero', s);

// ---------- reparación a pie ----------
let repairSteps = 0;
while (s.state === 'TARGET_REACHED' && repairSteps < 1000) {
  s = m.update(ctx(TARGET.x, TARGET.z, { driving: false, onFoot: true, interact: true }));
  repairSteps++;
  if (repairSteps % 40 === 0 || s.state === 'REPAIRED') trace(`reparando ${(repairSteps * DT).toFixed(2)}s`, s);
}
check('mantener E a pie 2 s -> REPAIRED', s.state === 'REPAIRED', s.state);
check('progreso final = 1', s.repairProgress === 1, `${s.repairProgress}`);
check('repaired = true', s.repaired === true);
check('tomó ~2 s (120 frames de 1/60)', repairSteps >= 119 && repairSteps <= 121, `${repairSteps} frames`);

// ---------- REPAIRED -> RETURNING -> COMPLETED ----------
s = m.update(ctx(TARGET.x, TARGET.z, { driving: false, onFoot: true }));
check('reparado y a pie sigue REPAIRED', s.state === 'REPAIRED', s.state);
trace('reparado-a-pie', s);

s = m.update(ctx(TARGET.x, TARGET.z, { driving: true, onFoot: false }));
check('volver a conducir -> RETURNING', s.state === 'RETURNING', s.state);
check('hint de regreso', s.hint === 'Volvé a Villafranca', s.hint);
trace('vuelve-a-conducir', s);

// ---------- camino negativo: lejos del regreso no completa ----------
s = m.update(ctx(TARGET.x, TARGET.z, { driving: true, onFoot: false }));
check('seguir lejos del inicio NO completa', s.state === 'RETURNING', s.state);
trace('lejos-regreso', s);

s = m.update(ctx(RETURN.x, RETURN.z, { driving: true, onFoot: false }));
check('llegar al inicio (<= 25 m) -> COMPLETED', s.state === 'COMPLETED', s.state);
check('completed = true', s.completed === true);
check('repaired sigue true al completar', s.repaired === true);
check('elapsedS > 0', s.elapsedS > 0, `${s.elapsedS.toFixed(2)} s`);
trace('regresa-inicio', s);

// ---------- COMPLETED es terminal ----------
const frozenElapsed = s.elapsedS;
s = m.update(ctx(TARGET.x, TARGET.z, { driving: false, onFoot: true, interact: true }));
check('COMPLETED es terminal (no vuelve atrás)', s.state === 'COMPLETED', s.state);
check('el reloj se congela al completar', s.elapsedS === frozenElapsed, `${s.elapsedS.toFixed(2)} s`);

// ---------- reset ----------
m.reset();
const r = m.snapshot;
check('reset -> NOT_STARTED', r.state === 'NOT_STARTED', r.state);
check('reset -> repairProgress 0', r.repairProgress === 0, `${r.repairProgress}`);
check('reset -> elapsedS 0', r.elapsedS === 0, `${r.elapsedS}`);
check('reset -> repaired/completed false', r.repaired === false && r.completed === false);
trace('reset', r);

// ==========================================================================
console.log('\n=== B. soltar E resetea el progreso (no lo congela) ===');
const m2 = createMission(FIRST_ROUTE);
m2.update(ctx(START.x, START.z, { driving: true, onFoot: false }));
m2.update(ctx(TARGET.x, TARGET.z, { driving: true, onFoot: false }));
let s2;
for (let i = 0; i < 60; i++) {
  s2 = m2.update(ctx(TARGET.x, TARGET.z, { driving: false, onFoot: true, interact: true }));
}
check('a 1 s de E el progreso está a medias', s2.repairProgress > 0.4 && s2.repairProgress < 0.6, `${s2.repairProgress.toFixed(2)}`);
trace('reparando-1s', s2);
s2 = m2.update(ctx(TARGET.x, TARGET.z, { driving: false, onFoot: true, interact: false }));
check('soltar E resetea repairProgress a 0', s2.repairProgress === 0, `${s2.repairProgress}`);
check('soltar E no repara', s2.state === 'TARGET_REACHED', s2.state);
trace('suelta-E', s2);

// ==========================================================================
console.log('\n=== C. alejarse del objetivo a pie resetea el progreso ===');
const m3 = createMission(FIRST_ROUTE);
m3.update(ctx(START.x, START.z, { driving: true, onFoot: false }));
m3.update(ctx(TARGET.x, TARGET.z, { driving: true, onFoot: false }));
let s3;
for (let i = 0; i < 60; i++) {
  s3 = m3.update(ctx(TARGET.x, TARGET.z, { driving: false, onFoot: true, interact: true }));
}
const halfway = s3.repairProgress;
s3 = m3.update(ctx(TARGET.x + 200, TARGET.z, { driving: false, onFoot: true, interact: true }));
check('alejarse resetea el progreso a 0', s3.repairProgress === 0, `${s3.repairProgress}`);
check('alejarse no repara', s3.state === 'TARGET_REACHED', s3.state);
check('el progreso previo era no nulo (test no vacío)', halfway > 0.4, `${halfway.toFixed(2)}`);
trace('alejado', s3);

// ==========================================================================
console.log('\n=== D. radio de alcance por defecto (25 m) ===');
const m4 = createMission(FIRST_ROUTE);
m4.update(ctx(START.x, START.z, { driving: true, onFoot: false }));
let s4 = m4.update(ctx(TARGET.x + 26, TARGET.z, { driving: true, onFoot: false }));
check('a 26 m sigue ACTIVE', s4.state === 'ACTIVE', s4.state);
s4 = m4.update(ctx(TARGET.x + 24, TARGET.z, { driving: true, onFoot: false }));
check('a 24 m -> TARGET_REACHED', s4.state === 'TARGET_REACHED', s4.state);
trace('radio', s4);

// ==========================================================================
console.log('\n=== E. interactor (puro) ===');
const interactor = createInteractor([
  { id: 'a', label: 'A', x: 0, z: 0, radiusM: 5 },
  { id: 'b', label: 'B', x: 100, z: 0, radiusM: 3 },
]);
let q = interactor.query(3, 0);
check('elegir el alcanzable más cercano', q.available?.id === 'a', `${q.available?.id}`);
check('distancia al más cercano = 3 m', Math.abs(q.distanceM - 3) < 1e-9, `${q.distanceM}`);
q = interactor.query(6, 0);
check('fuera de radio: available null', q.available === null, `${q.available}`);
check('fuera de radio: distanceM = 6 (útil para el HUD)', Math.abs(q.distanceM - 6) < 1e-9, `${q.distanceM}`);
q = interactor.query(99, 0);
check('elige el OTRO cuando el primero está lejos', q.available?.id === 'b', `${q.available?.id}`);
check('distancia al segundo = 1 m', Math.abs(q.distanceM - 1) < 1e-9, `${q.distanceM}`);
const empty = createInteractor([]);
q = empty.query(0, 0);
check('lista vacía: available null y distanceM Infinity', q.available === null && q.distanceM === Infinity, `${q.distanceM}`);

// ------------------------------------------------------------------ resumen
const total = pass + fails.length;
console.log(`\n${pass}/${total} checks OK`);
if (fails.length) {
  console.log('FALLARON:');
  for (const f of fails) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('TODO OK');
