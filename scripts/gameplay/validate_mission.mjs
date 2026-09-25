// Validador de la máquina de estados de la misión "Repetidor sin señal".
//
// POR QUÉ EXISTE
//   `src/gameplay/mission.ts` es la lógica CENTRAL de la milestone y era el único
//   módulo del bucle sin test unitario: la cadena de `npm test` cubría terreno,
//   vías, ruta y datum, pero no la misión. Un estado mal transicionado (p. ej.
//   reparar a 20 m o desde el coche) no rompe el build ni el typecheck: solo se
//   ve jugando. Este validador fija las 11 cartas del packet d7-test-mision.
//
// POR QUÉ TRANSPILA Y NO REIMPLEMENTA
//   El test tiene que correr EL MISMO código que el juego, no una copia. Se usa el
//   patrón de `scripts/terrain/validate_terrain.mjs` y de `build_first_route.mjs`:
//   `ts.transpileModule` + import dinámico del módulo REAL. `mission.ts` es PURO
//   (no importa Babylon), por eso corre en Node sin más.
//
// QUÉ NO SE PRUEBA (a propósito)
//   El tope de `dt` vive en el llamador (`src/main.ts`), no en la misión. Probarlo
//   acá sería afirmar algo que este módulo no promete.
//
// Uso: node scripts/gameplay/validate_mission.mjs
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

// ---------------------------------------------------------------- transpilación
// Se transpila el módulo REAL de la misión y la ruta REAL que consume. No se
// reimplementa ni un `if` de la máquina de estados.
const tmp = mkdtempSync(resolve(here, '.mission-tmp-'));
function gen(rel, out) {
  const text = ts.transpileModule(readFileSync(resolve(root, rel), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, verbatimModuleSyntax: false },
  }).outputText;
  writeFileSync(resolve(tmp, out), text);
}
gen('src/gameplay/first-route.ts', 'first-route.gen.mjs');
gen('src/gameplay/mission.ts', 'mission.gen.mjs');

const { FIRST_ROUTE } = await import(`file://${resolve(tmp, 'first-route.gen.mjs')}`);
const { createMission, MISSION_NAME } = await import(`file://${resolve(tmp, 'mission.gen.mjs')}`);
rmSync(tmp, { recursive: true, force: true });

const START = FIRST_ROUTE.start;
const TARGET = FIRST_ROUTE.target;
const RETURN = FIRST_ROUTE.returnPoint;

// Defaults declarados por la misión (se leen del código, no se asumen).
const REACH_DEFAULT_M = 25;
const REPAIR_DEFAULT_M = 6;
const DT = 1 / 60;

const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const ctx = (x, z, over = {}) => ({ x, z, driving: false, onFoot: true, interact: false, dt: DT, ...over });
const driving = (over = {}) => ({ driving: true, onFoot: false, ...over });
const onFoot = (over = {}) => ({ driving: false, onFoot: true, ...over });

// Punto en planta a `d` metros del objetivo / del regreso. El desplazamiento es
// sobre +X, así la distancia es exactamente `d` (margen de 1 m en los bordes).
const nearTarget = (d) => ({ x: TARGET.x + d, z: TARGET.z });
const nearReturn = (d) => ({ x: RETURN.x + d, z: RETURN.z });

// --- arneses: mismo camino para todos los casos, sin reimplementar la lógica ---
function activeMission() {
  const m = createMission(FIRST_ROUTE);
  m.update(ctx(START.x, START.z, driving())); // NOT_STARTED -> ACTIVE
  return m;
}
function reachedMission() {
  const m = activeMission();
  m.update(ctx(TARGET.x, TARGET.z, driving())); // ACTIVE -> TARGET_REACHED
  return m;
}
function completedMission() {
  const m = reachedMission();
  const { m: repaired } = repairOnFoot(m);
  repaired.update(ctx(TARGET.x, TARGET.z, driving())); // REPAIRED -> RETURNING
  repaired.update(ctx(RETURN.x, RETURN.z, driving())); // RETURNING -> COMPLETED
  return repaired;
}
/** Repara de verdad: a pie, a 3 m, con E mantenida. Devuelve cuántos frames costó. */
function repairOnFoot(m) {
  let s = m.snapshot;
  let steps = 0;
  while (s.state === 'TARGET_REACHED' && steps < 1000) {
    s = m.update(ctx(nearTarget(3).x, nearTarget(3).z, onFoot({ interact: true })));
    steps++;
  }
  return { m, s, steps };
}

console.log(`=== ruta real: ${FIRST_ROUTE.name} ===`);
console.log(`inicio/regreso (${START.x}, ${START.z}) · objetivo (${TARGET.x}, ${TARGET.z})`);
console.log(`defaults leídos: reachRadiusM=${REACH_DEFAULT_M} m · repairRadiusM=${REPAIR_DEFAULT_M} m · dt=${DT.toFixed(5)} s`);

// ==========================================================================
console.log('\n=== caso 0: precondiciones ===');
{
  const m0 = createMission(FIRST_ROUTE);
  check('0. nombre de la misión', MISSION_NAME === 'REPETIDOR SIN SEÑAL', `"${MISSION_NAME}"`);
  check('0. arranca en NOT_STARTED', m0.snapshot.state === 'NOT_STARTED', `state=${m0.snapshot.state}`);
  check('0. arranca con progreso 0', m0.snapshot.repairProgress === 0, `repairProgress=${m0.snapshot.repairProgress}`);
  check('0. arranca con elapsedS 0', m0.snapshot.elapsedS === 0, `elapsedS=${m0.snapshot.elapsedS}`);
}

// ==========================================================================
console.log('\n=== caso 1: NOT_STARTED → ACTIVE sólo al conducir ===');
{
  const m = createMission(FIRST_ROUTE);
  let s = m.update(ctx(START.x, START.z, onFoot({ interact: true })));
  check('1. a pie con E sigue NOT_STARTED', s.state === 'NOT_STARTED', `state=${s.state} esperado=NOT_STARTED`);
  check('1. a pie no arranca el reloj', s.elapsedS === 0, `elapsedS=${s.elapsedS} esperado=0`);
  s = m.update(ctx(START.x, START.z, driving()));
  check('1. al subir al 4x4 pasa a ACTIVE', s.state === 'ACTIVE', `state=${s.state} esperado=ACTIVE`);
  check('1. al arrancar corre el reloj', s.elapsedS > 0, `elapsedS=${s.elapsedS.toFixed(3)} esperado>0`);
}

// ==========================================================================
console.log('\n=== caso 2: ACTIVE → TARGET_REACHED a <= 25 m, y no antes ===');
{
  const m = activeMission();
  let s = m.update(ctx(nearTarget(26).x, nearTarget(26).z, driving()));
  check('2. a 26 m (>25) sigue ACTIVE', s.state === 'ACTIVE', `state=${s.state} esperado=ACTIVE d=${s.distanceToTargetM.toFixed(2)}m`);
  check('2. la distancia medida es ~26 m', near(s.distanceToTargetM, 26), `d=${s.distanceToTargetM.toFixed(6)}m esperado=26`);
  s = m.update(ctx(nearTarget(24).x, nearTarget(24).z, driving()));
  check('2. a 24 m (<=25) pasa a TARGET_REACHED', s.state === 'TARGET_REACHED', `state=${s.state} esperado=TARGET_REACHED d=${s.distanceToTargetM.toFixed(2)}m`);
}

// ==========================================================================
console.log('\n=== caso 3: reparar desde el coche NO avanza el progreso ===');
{
  const m = reachedMission();
  check('3. precondición: está en TARGET_REACHED', m.snapshot.state === 'TARGET_REACHED', `state=${m.snapshot.state} esperado=TARGET_REACHED`);
  let s = m.snapshot;
  for (let i = 0; i < 600; i++) s = m.update(ctx(TARGET.x, TARGET.z, driving({ interact: true })));
  check('3. tras 10 s de E desde el coche sigue TARGET_REACHED', s.state === 'TARGET_REACHED', `state=${s.state} esperado=TARGET_REACHED`);
  check('3. el progreso desde el coche queda en 0', s.repairProgress === 0, `repairProgress=${s.repairProgress} esperado=0`);
  check('3. el HUD pide bajar del 4x4', s.hint === 'Bajá del 4x4 (F) y acercate', `hint="${s.hint}"`);
}

// ==========================================================================
console.log('\n=== caso 4: a pie a 20 m (dentro de reach, fuera de repair) NO repara ===');
{
  const m = reachedMission();
  let s = m.snapshot;
  for (let i = 0; i < 600; i++) s = m.update(ctx(nearTarget(20).x, nearTarget(20).z, onFoot({ interact: true })));
  check('4. a 20 m con E 10 s sigue TARGET_REACHED', s.state === 'TARGET_REACHED', `state=${s.state} esperado=TARGET_REACHED d=${s.distanceToTargetM.toFixed(2)}m`);
  check('4. el progreso fuera del radio de reparación queda en 0', s.repairProgress === 0, `repairProgress=${s.repairProgress} esperado=0`);
  check('4. el aviso de E aparece sólo dentro del radio de reparación', s.hint === 'Acercate al repetidor', `hint="${s.hint}"`);

  // Borde fino del radio de reparación por defecto (6 m): 7 no repara, 5 sí.
  const m7 = reachedMission();
  let s7 = m7.snapshot;
  for (let i = 0; i < 300; i++) s7 = m7.update(ctx(nearTarget(7).x, nearTarget(7).z, onFoot({ interact: true })));
  check('4b. a 7 m (>6) con E 5 s no repara', s7.state === 'TARGET_REACHED' && s7.repairProgress === 0, `state=${s7.state} repairProgress=${s7.repairProgress}`);
  const { s: s5 } = repairOnFoot(reachedMission());
  check('4c. a 3 m (<6) sí repara (default repairRadiusM=6)', s5.state === 'REPAIRED', `state=${s5.state} esperado=REPAIRED`);
}

// ==========================================================================
console.log('\n=== caso 5: a pie a 3 m + E durante repairSeconds → REPAIRED ===');
const R = repairOnFoot(reachedMission());
{
  check('5. mantener E a pie 2 s repara', R.s.state === 'REPAIRED', `state=${R.s.state} tras ${R.steps} frames (${(R.steps * DT).toFixed(2)} s)`);
  check('5. tarda ~2 s (120 frames de 1/60)', R.steps >= 118 && R.steps <= 122, `steps=${R.steps} esperado≈120`);
}

// ==========================================================================
console.log('\n=== caso 6: soltar E a mitad resetea el progreso (no se cocina) ===');
{
  const m = reachedMission();
  let s = m.snapshot;
  for (let i = 0; i < 60; i++) s = m.update(ctx(nearTarget(3).x, nearTarget(3).z, onFoot({ interact: true })));
  check('6. a 1 s el progreso está a medias (test no vacío)', s.repairProgress > 0.3 && s.repairProgress < 0.7, `repairProgress=${s.repairProgress.toFixed(3)} esperado≈0.5`);
  s = m.update(ctx(nearTarget(3).x, nearTarget(3).z, onFoot({ interact: false })));
  check('6. soltar E resetea el progreso a 0', s.repairProgress === 0, `repairProgress=${s.repairProgress} esperado=0`);
  check('6. soltar E no repara', s.state === 'TARGET_REACHED', `state=${s.state} esperado=TARGET_REACHED`);
}

// ==========================================================================
console.log('\n=== caso 7: al reparar repairProgress = 1 (baliza verde) ===');
{
  check('7. repairProgress === 1 al reparar', R.s.repairProgress === 1, `repairProgress=${R.s.repairProgress} esperado=1`);
  check('7. repaired === true al reparar', R.s.repaired === true, `repaired=${R.s.repaired}`);
  const after = R.m.update(ctx(nearTarget(3).x, nearTarget(3).z, onFoot()));
  check('7. sigue en 1 en los frames siguientes (a pie)', after.repairProgress === 1, `repairProgress=${after.repairProgress} esperado=1`);
}

// ==========================================================================
console.log('\n=== caso 8: REPAIRED → RETURNING sólo al conducir ===');
{
  const m = repairOnFoot(reachedMission()).m;
  let s = m.update(ctx(TARGET.x, TARGET.z, onFoot()));
  check('8. reparado y a pie sigue REPAIRED', s.state === 'REPAIRED', `state=${s.state} esperado=REPAIRED`);
  check('8. el aviso pide volver', s.hint === 'Volvé a Villafranca', `hint="${s.hint}"`);
  s = m.update(ctx(TARGET.x, TARGET.z, driving()));
  check('8. al conducir pasa a RETURNING', s.state === 'RETURNING', `state=${s.state} esperado=RETURNING`);
}

// ==========================================================================
console.log('\n=== caso 9: RETURNING → COMPLETED a <= 25 m del regreso, no antes ===');
{
  const m = repairOnFoot(reachedMission()).m;
  m.update(ctx(TARGET.x, TARGET.z, driving())); // REPAIRED -> RETURNING
  let s = m.update(ctx(nearReturn(26).x, nearReturn(26).z, driving()));
  check('9. a 26 m (>25) del regreso sigue RETURNING', s.state === 'RETURNING', `state=${s.state} esperado=RETURNING d=${s.distanceToReturnM.toFixed(2)}m`);
  check('9. la distancia medida al regreso es ~26 m', near(s.distanceToReturnM, 26), `d=${s.distanceToReturnM.toFixed(6)}m esperado=26`);
  s = m.update(ctx(nearReturn(24).x, nearReturn(24).z, driving()));
  check('9. a 24 m (<=25) completa', s.state === 'COMPLETED', `state=${s.state} esperado=COMPLETED d=${s.distanceToReturnM.toFixed(2)}m`);
  check('9. completed === true al completar', s.completed === true, `completed=${s.completed}`);
}

// ==========================================================================
console.log('\n=== caso 10: reset() deja NOT_STARTED, elapsedS 0 y progreso 0 ===');
{
  const m = completedMission();
  m.reset();
  const r = m.snapshot;
  check('10. reset → NOT_STARTED', r.state === 'NOT_STARTED', `state=${r.state} esperado=NOT_STARTED`);
  check('10. reset → elapsedS 0', r.elapsedS === 0, `elapsedS=${r.elapsedS} esperado=0`);
  check('10. reset → repairProgress 0', r.repairProgress === 0, `repairProgress=${r.repairProgress} esperado=0`);
  check('10. reset → repaired/completed false', r.repaired === false && r.completed === false, `repaired=${r.repaired} completed=${r.completed}`);
  const again = m.update(ctx(START.x, START.z, driving()));
  check('10. tras reset se puede volver a arrancar', again.state === 'ACTIVE', `state=${again.state} esperado=ACTIVE`);
}

// ==========================================================================
console.log('\n=== caso 11: COMPLETED es terminal ===');
{
  const m = completedMission();
  const frozen = m.snapshot.elapsedS;
  check('11. precondición: está en COMPLETED', m.snapshot.state === 'COMPLETED', `state=${m.snapshot.state} esperado=COMPLETED`);
  let s = m.update(ctx(TARGET.x, TARGET.z, onFoot({ interact: true })));
  check('11. con E a pie no vuelve a TARGET_REACHED', s.state === 'COMPLETED', `state=${s.state} esperado=COMPLETED`);
  s = m.update(ctx(START.x, START.z, driving()));
  check('11. al manejar no vuelve a RETURNING', s.state === 'COMPLETED', `state=${s.state} esperado=COMPLETED`);
  check('11. el reloj queda congelado al completar', s.elapsedS === frozen, `elapsedS=${s.elapsedS} congelado=${frozen}`);
}

// ------------------------------------------------------------------ resumen
const total = pass + fails.length;
console.log(`\n${pass}/${total} checks OK`);
if (fails.length) {
  console.log('FALLARON:');
  for (const f of fails) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('TODO OK');
