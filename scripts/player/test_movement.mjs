// Test de movimiento a pie (FASE F). Transpila `src/player/movement.ts` con
// `typescript` y lo corre en NODE, sin Babylon (patrón exacto de
// scripts/terrain/validate_terrain.mjs, que transpila src/heightfield.ts).
//
// Por qué un terreno SINTÉTICO: `heightAt` es una caja negra. Si usáramos el
// terreno real, "el jugador sigue al terreno" sería una tautología (compararía
// heightAt contra sí misma). Acá el terreno es `h = 0.25·x + 0.10·z + 40`, una
// pendiente conocida en la que se puede predecir el Y esperado a mano.
//
// Uso: node scripts/player/test_movement.mjs
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
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

// ------------------------------------------------------------ transpilar TS
const tmp = mkdtempSync(resolve(here, '.test-tmp-'));
const source = readFileSync(resolve(root, 'src/player/movement.ts'), 'utf8');
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, verbatimModuleSyntax: false },
}).outputText;
writeFileSync(resolve(tmp, 'movement.gen.mjs'), js);
const M = await import(`file://${resolve(tmp, 'movement.gen.mjs')}`);
rmSync(tmp, { recursive: true, force: true });

const { WALK_SPEED_MPS, RUN_SPEED_MPS, createCharacterState, stepCharacter, exitPosition } = M;

// --------------------------------------------------- terreno sintético conocido
// Plano inclinado: 0,25 (este) y 0,10 (norte). Y esperado = 0.25x + 0.10z + 40.
const terrain = { heightAt: (x, z) => 0.25 * x + 0.1 * z + 40 };
const expectedY = (x, z) => 0.25 * x + 0.1 * z + 40;

console.log('=== 1. normalización de la diagonal (W+D == W) ===');
// Se corre medio segundo con W sola y con W+D, desde el mismo estado.
function runSeconds(forward, strafe, seconds, dt = 1 / 60, run = false, yaw = 0) {
  const s = createCharacterState(1000, 1000, yaw, terrain);
  const steps = Math.round(seconds / dt);
  for (let i = 0; i < steps; i++) stepCharacter(s, { forward, strafe, run }, dt, terrain);
  return s;
}
const onlyW = runSeconds(1, 0, 0.5);
const wPlusD = runSeconds(1, 1, 0.5);
console.log(
  `  W: v=${onlyW.speed.toFixed(4)} m/s  |  W+D: v=${wPlusD.speed.toFixed(4)} m/s  |  ` +
    `Δ=${Math.abs(onlyW.speed - wPlusD.speed).toExponential(2)}`,
);
check(
  'W+D da la MISMA velocidad que W (±1e-9)',
  Math.abs(onlyW.speed - wPlusD.speed) < 1e-9,
  `${onlyW.speed.toFixed(6)} vs ${wPlusD.speed.toFixed(6)}`,
);
// Distancia recorrida en planta idéntica.
const distW = Math.hypot(onlyW.x - 1000, onlyW.z - 1000);
const distWD = Math.hypot(wPlusD.x - 1000, wPlusD.z - 1000);
console.log(`  distancia W=${distW.toFixed(4)} m  W+D=${distWD.toFixed(4)} m`);
check('W+D recorre la MISMA distancia que W', Math.abs(distW - distWD) < 1e-9, `${distW.toFixed(6)} vs ${distWD.toFixed(6)}`);

console.log('\n=== 2. convergencia de velocidad (no la salta) ===');
{
  const s = createCharacterState(0, 0, 0, terrain);
  const traza = [];
  let maxJump = 0;
  let prev = 0;
  for (let i = 0; i < 120; i++) {
    stepCharacter(s, { forward: 1, strafe: 0, run: false }, 1 / 60, terrain);
    maxJump = Math.max(maxJump, Math.abs(s.speed - prev));
    prev = s.speed;
    if (i % 20 === 0) traza.push(`${(i / 60).toFixed(2)}s:${s.speed.toFixed(3)}`);
  }
  traza.push(`2.00s:${s.speed.toFixed(3)}`);
  console.log(`  rampa caminando: ${traza.join('  ')}`);
  console.log(`  salto máximo por frame: ${maxJump.toFixed(4)} m/s (≤ accel·dt)`);
  check('velocidad converge a WALK_SPEED_MPS', Math.abs(s.speed - WALK_SPEED_MPS) < 1e-6, `${s.speed.toFixed(6)} vs ${WALK_SPEED_MPS}`);
  check('no salta la velocidad en un frame', maxJump <= 12 * (1 / 60) + 1e-9, `salto max ${maxJump.toFixed(6)}`);
}
{
  const s = createCharacterState(0, 0, 0, terrain);
  for (let i = 0; i < 180; i++) stepCharacter(s, { forward: 1, strafe: 0, run: true }, 1 / 60, terrain);
  console.log(`  corriendo 3 s: v=${s.speed.toFixed(4)} m/s`);
  check('velocidad converge a RUN_SPEED_MPS', Math.abs(s.speed - RUN_SPEED_MPS) < 1e-6, `${s.speed.toFixed(6)} vs ${RUN_SPEED_MPS}`);
}

console.log('\n=== 3. Y sigue al terreno inclinado ===');
{
  const s = createCharacterState(1000, 1000, 0, terrain);
  let worst = 0;
  for (let i = 0; i < 240; i++) {
    stepCharacter(s, { forward: 1, strafe: 0.3, run: true }, 1 / 60, terrain);
    worst = Math.max(worst, Math.abs(s.y - expectedY(s.x, s.z)));
  }
  console.log(`  tras 4 s: (${s.x.toFixed(3)}, ${s.z.toFixed(3)})  y=${s.y.toFixed(4)}  esperado=${expectedY(s.x, s.z).toFixed(4)}`);
  check('y == 0.25x+0.10z+40 en todo el recorrido (1e-9)', worst < 1e-9, `peor Δ=${worst.toExponential(2)}`);
}

console.log('\n=== 4. nunca Y = 0 dentro de la ventana ===');
{
  // La ventana es [0,6000]. Se camina pegado al borde sur/oeste para intentar
  // salir: si el módulo no recortara, heightAt daría 0 y el personaje caería.
  const s = createCharacterState(20, 20, 0, terrain);
  let minY = Infinity;
  let sawZero = false;
  for (let i = 0; i < 600; i++) {
    // Apunta hacia -X/-Z (fuera de la ventana).
    stepCharacter(s, { forward: -1, strafe: -1, run: true }, 1 / 30, terrain);
    if (s.y === 0) sawZero = true;
    minY = Math.min(minY, s.y);
    if (s.x <= 0 || s.z <= 0) s.yaw = 0; // no debería hacer falta: se recorta
  }
  console.log(`  fin: (${s.x.toFixed(3)}, ${s.z.toFixed(3)})  minY=${minY.toFixed(3)}  vioY0=${sawZero}`);
  check('x/z recortados a [0,6000]', s.x >= 0 && s.x <= 6000 && s.z >= 0 && s.z <= 6000, `(${s.x.toFixed(2)}, ${s.z.toFixed(2)})`);
  check('nunca devuelve y = 0 dentro de la ventana', !sawZero, `minY=${minY.toFixed(3)}`);
}

console.log('\n=== 5. la guiñada converge y no salta ===');
{
  const s = createCharacterState(1000, 1000, 0, terrain);
  const objetivo = Math.atan2(1, 0); // moverse hacia +X ⇒ yaw = atan2(1,0) = π/2
  let maxJump = 0;
  let prev = s.yaw;
  const traza = [];
  for (let i = 0; i < 90; i++) {
    stepCharacter(s, { forward: 0, strafe: 1, run: false }, 1 / 60, terrain);
    const d = Math.abs(Math.atan2(Math.sin(s.yaw - prev), Math.cos(s.yaw - prev)));
    maxJump = Math.max(maxJump, d);
    prev = s.yaw;
    if (i % 15 === 0) traza.push(`${(i / 60).toFixed(2)}s:${((s.yaw * 180) / Math.PI).toFixed(1)}°`);
  }
  traza.push(`fin:${((s.yaw * 180) / Math.PI).toFixed(1)}°`);
  console.log(`  guiñada hacia +X (objetivo 90°): ${traza.join('  ')}`);
  console.log(`  salto máximo por frame: ${((maxJump * 180) / Math.PI).toFixed(3)}° (≤ 9 rad/s · dt = ${((9 / 60 * 180) / Math.PI).toFixed(2)}°)`);
  const err = Math.abs(Math.atan2(Math.sin(s.yaw - objetivo), Math.cos(s.yaw - objetivo)));
  check('la guiñada converge a la dirección de movimiento', err < 1e-6, `error ${((err * 180) / Math.PI).toFixed(6)}°`);
  check('la guiñada no salta de golpe', maxJump <= 9 * (1 / 60) + 1e-9, `salto max ${((maxJump * 180) / Math.PI).toFixed(4)}°`);
}
{
  // Sin input conserva la guiñada.
  const s = createCharacterState(1000, 1000, 1.234, terrain);
  for (let i = 0; i < 60; i++) stepCharacter(s, { forward: 0, strafe: 0, run: false }, 1 / 60, terrain);
  console.log(`  sin input, yaw = ${s.yaw.toFixed(6)} (inicial 1.234000)`);
  check('sin input conserva la guiñada', Math.abs(s.yaw - 1.234) < 1e-9, `${s.yaw.toFixed(6)}`);
}

console.log('\n=== 6. dt grande (1 s) no teletransporta ===');
{
  const s = createCharacterState(1000, 1000, 0, terrain);
  stepCharacter(s, { forward: 1, strafe: 0, run: true }, 1, terrain);
  const d = Math.hypot(s.x - 1000, s.z - 1000);
  const maxPosible = RUN_SPEED_MPS * 0.1;
  console.log(`  un paso de dt=1 s movió ${d.toFixed(4)} m (≤ RUN·0.1 = ${maxPosible.toFixed(2)} m)`);
  check('dt=1 s se satura a 0,1 s', d <= maxPosible + 1e-9, `${d.toFixed(6)} m`);
  check('dt=1 s no supera la velocidad de carrera', s.speed <= RUN_SPEED_MPS + 1e-9, `${s.speed.toFixed(6)}`);
}
{
  // dt=0 y dt negativo no rompen ni mueven.
  const s = createCharacterState(1000, 1000, 0, terrain);
  stepCharacter(s, { forward: 1, strafe: 0, run: false }, 0, terrain);
  stepCharacter(s, { forward: 1, strafe: 0, run: false }, -5, terrain);
  check('dt=0 y dt<0 no mueven al personaje', s.x === 1000 && s.z === 1000 && s.speed === 0, `(${s.x}, ${s.z}) v=${s.speed}`);
}

console.log('\n=== 7. exitPosition: al costado y sobre el terreno ===');
{
  const vx = 2000;
  const vz = 3000;
  const yaw = 0; // mirando +Z ⇒ derecha = +X
  const p = exitPosition(vx, vz, yaw, terrain);
  const dx = p.x - vx;
  const dz = p.z - vz;
  const dist = Math.hypot(dx, dz);
  // Proyección sobre la derecha (cos yaw, −sin yaw) = (1, 0).
  const along = dx * Math.cos(yaw) + dz * -Math.sin(yaw);
  const perpendicular = Math.abs(dx * -Math.sin(yaw) - dz * Math.cos(yaw));
  console.log(
    `  yaw=0 ⇒ derecho=+X. salida=(${p.x.toFixed(3)}, ${p.z.toFixed(3)}, y=${p.y.toFixed(4)})  ` +
      `dist=${dist.toFixed(4)} m  a lo largo=${along.toFixed(4)} m  perpendicular=${perpendicular.toFixed(4)} m`,
  );
  check('exitPosition está a un costado (no delante/atrás)', Math.abs(along - 2) < 1e-9 && perpendicular < 1e-9, `along=${along}`);
  check('exitPosition usa el ancho por defecto (2,0 m)', Math.abs(dist - 2) < 1e-9, `${dist.toFixed(6)} m`);
  check('exitPosition devuelve y del terreno', Math.abs(p.y - expectedY(p.x, p.z)) < 1e-9, `y=${p.y.toFixed(6)} vs ${expectedY(p.x, p.z).toFixed(6)}`);
}
{
  // Con yaw = π/2 (mirando +X), la derecha es -Z.
  const yaw = Math.PI / 2;
  const p = exitPosition(2000, 3000, yaw, terrain);
  const dx = p.x - 2000;
  const dz = p.z - 3000;
  console.log(`  yaw=90° ⇒ derecho=−Z. salida=(${p.x.toFixed(3)}, ${p.z.toFixed(3)}, y=${p.y.toFixed(4)})  Δ=(${dx.toFixed(3)}, ${dz.toFixed(3)})`);
  check('exitPosition rota con la guiñada (derecha = −Z a 90°)', Math.abs(dx) < 1e-9 && Math.abs(dz + 2) < 1e-9, `Δ=(${dx.toFixed(4)}, ${dz.toFixed(4)})`);
}
{
  // `sideM` explícito.
  const p = exitPosition(2000, 3000, 0, terrain, 3.5);
  console.log(`  sideM=3.5 ⇒ x=${p.x.toFixed(3)} (2000 + 3.5)`);
  check('exitPosition respeta sideM', Math.abs(p.x - 2003.5) < 1e-9, `x=${p.x}`);
}
{
  // En el borde de la ventana el offset no puede escaparse.
  const p = exitPosition(1, 3000, Math.PI, terrain, 5); // derecha = −X
  console.log(`  borde oeste: salida x=${p.x.toFixed(3)} (recortada a ≥0), y=${p.y.toFixed(4)}`);
  check('exitPosition recorta a la ventana (no devuelve y=0 de afuera)', p.x >= 0 && p.y !== 0, `x=${p.x} y=${p.y}`);
}

// ------------------------------------------------------------------- resumen
const total = pass + fails.length;
console.log(`\n${pass}/${total} checks OK`);
if (fails.length) {
  console.log('FALLARON:');
  for (const f of fails) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('TODO OK');
