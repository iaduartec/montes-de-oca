// Mediciones de física del 4x4 (FASE 4), SIN navegador y sin dependencias nuevas.
//
// Cómo funciona: transpila `src/vehicle/physics.ts` (módulo puro, cero imports) y
// `src/heightfield.ts` (sampler real, idéntico al del juego) con el `typescript`
// del proyecto, los importa desde Node y corre la MISMA física que la app.
//
// Superficies:
//   - Plano sintético de pendiente conocida (control analítico).
//   - Terreno real de Villafranca: los 36 tiles publicados, con el MISMO datum y
//     la MISMA interpolación SW→NE que `src/terrain.ts`.
//
// Salida: output/vehicle_measurements.json + resumen por consola.
//
// Uso: node scripts/vehicle/measure_physics.mjs
import { readFileSync, writeFileSync, rmSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const outDir = resolve(root, 'output');
mkdirSync(outDir, { recursive: true });

/** Transpila un .ts del proyecto y lo importa desde Node. */
async function loadTs(relPath) {
  const source = resolve(root, relPath);
  const genFile = resolve(here, `.${relPath.replace(/[\\/]/g, '_')}.gen.mjs`);
  const transpiled = ts.transpileModule(readFileSync(source, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      verbatimModuleSyntax: false,
    },
  }).outputText;
  const withExtensions = transpiled
    .replace(/(['"])(\.\.?\/[^'"]+)\1/g, '$1$2.mjs$1')
    .replace(/(['"])(@babylonjs\/core\/[^'"]+)\1/g, '$1$2.js$1');
  writeFileSync(genFile, withExtensions);
  try {
    return await import(pathToFileURL(genFile).href);
  } finally {
    if (existsSync(genFile)) rmSync(genFile);
  }
}

const physics = await loadTs('src/vehicle/physics.ts');
const { createHeightfield, containsPoint, gridExtent } = await loadTs('src/heightfield.ts');
const {
  stepVehicleFixed,
  createVehicleState,
  DEFAULT_VEHICLE_PARAMS,
  GRAVITY,
} = physics;

const config = JSON.parse(readFileSync(resolve(root, 'public/terrain/config.json'), 'utf8'));
const datum = config.verticalDatum * config.worldScale;

// ------------------------------- Superficies -------------------------------
/** Plano sintético: pendiente `slopeDeg`, ascendiendo hacia `azimuthDeg` (0=N). */
function syntheticPlane(slopeDeg, azimuthDeg = 0) {
  const g = Math.tan((slopeDeg * Math.PI) / 180);
  const az = (azimuthDeg * Math.PI) / 180;
  const gE = g * Math.sin(az);
  const gN = g * Math.cos(az);
  const s = Math.sqrt(1 + gE * gE + gN * gN);
  const normal = { x: -gE / s, y: 1 / s, z: -gN / s };
  return {
    kind: 'synthetic',
    slopeDeg,
    heightAt: (x, z) => gE * x + gN * z,
    normalAt: () => normal,
  };
}

/** Terreno real multi-tile, con la semántica exacta de src/terrain.ts. */
function makeRealSurface() {
  const tilesDir = resolve(root, 'public/terrain/tiles');
  const grids = readdirSync(tilesDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(resolve(tilesDir, f), 'utf8')).grid);
  const samplers = grids.map((g) => createHeightfield(g, config.worldScale));
  function resolveSampler(x, z) {
    for (const s of samplers) if (containsPoint(s.grid, x, z)) return s;
    let best = samplers[0];
    let bestD = Infinity;
    for (const s of samplers) {
      const e = gridExtent(s.grid);
      const d = (x - e.centerX) ** 2 + (z - e.centerZ) ** 2;
      if (d < bestD) { bestD = d; best = s; }
    }
    return best;
  }
  return {
    kind: 'real',
    heightAt: (x, z) => resolveSampler(x, z).heightAt(x, z) - datum,
    normalAt: (x, z) => resolveSampler(x, z).normalAt(x, z),
    absoluteHeightAt: (x, z) => resolveSampler(x, z).heightAt(x, z),
  };
}

const realSurface = makeRealSurface();

function localSlopeDeg(surface, x, z) {
  const n = surface.normalAt(x, z);
  const ny = Math.max(n.y, 1e-6);
  return (Math.atan(Math.hypot(n.x / ny, n.z / ny)) * 180) / Math.PI;
}
function upSlopeYaw(surface, x, z) {
  const n = surface.normalAt(x, z);
  const ny = Math.max(n.y, 1e-6);
  const gE = -n.x / ny;
  const gN = -n.z / ny;
  return Math.atan2(gE, gN); // forward=(sin,cos)
}

/** Corre la física `seconds` y devuelve el estado final. `onSample` opcional. */
function run(surface, state, input, seconds, params, dt = 1 / 120, onSample = null) {
  const steps = Math.round(seconds / dt);
  for (let i = 0; i < steps; i++) {
    stepVehicleFixed(state, input, dt, params, surface);
    if (onSample) onSample(state, i * dt);
  }
  return state;
}

const results = {
  generado_por: 'scripts/vehicle/measure_physics.mjs',
  parametros: DEFAULT_VEHICLE_PARAMS,
  teoria: {
    pendiente_max_por_traccion_deg: (Math.atan(DEFAULT_VEHICLE_PARAMS.grip) * 180) / Math.PI,
    nota: 'Con tracción μ y normal m·g·cosθ, el límite de subida es atan(μ).',
  },
  pendiente_max: {},
  bajada_punto_muerto: {},
  traccion_desde_parado: {},
  estabilidad: {},
};

// ============================ 1. Pendiente máxima ============================
function syntheticClimb(slopeDeg, params) {
  const surface = syntheticPlane(slopeDeg, 0);
  const s = createVehicleState(0, 0, 0); // yaw 0 = sube hacia +Z
  let minSpeedAfterRun = Infinity;
  run(surface, s, { throttle: 1, steer: 0, handbrake: false, neutral: false }, 25, params, 1 / 120, (st, t) => {
    if (t > 6 && st.speed < minSpeedAfterRun) minSpeedAfterRun = st.speed;
  });
  return { finalSpeed: s.speed, minSpeedAfterRun, climbed: s.speed > 0.5 };
}

{
  const sweep = [];
  let maxClimb = 0;
  let lastClimbSpeed = 0;
  for (let a = 20; a <= 45; a += 0.5) {
    const r = syntheticClimb(a, DEFAULT_VEHICLE_PARAMS);
    sweep.push({ slopeDeg: a, finalSpeed: Number(r.finalSpeed.toFixed(3)), climbed: r.climbed });
    if (r.climbed) { maxClimb = a; lastClimbSpeed = r.finalSpeed; }
  }
  results.pendiente_max.sintetico = {
    descripcion: 'Plano sintético, desde parado, acelerador a fondo 25 s. "sube" = velocidad final > 0.5 m/s.',
    pendiente_max_escalable_deg: maxClimb,
    velocidad_en_el_limite_kmh: Number((lastClimbSpeed * 3.6).toFixed(1)),
    teoria_atan_mu_deg: results.teoria.pendiente_max_por_traccion_deg,
    barrido: sweep,
  };
}

{
  // Real: probar a subir desde ~35 m abajo del punto, orientado a la máxima pendiente.
  const candidates = [
    { x: 3320, z: 3705 },
    { x: 2280, z: 4100 },
    { x: 2690, z: 4350 },
    { x: 3685, z: 3365 },
    { x: 2795, z: 2935 },
  ];
  const tests = [];
  for (const c of candidates) {
    const slope = localSlopeDeg(realSurface, c.x, c.z);
    const yaw = upSlopeYaw(realSurface, c.x, c.z);
    const s = createVehicleState(c.x, c.z, yaw);
    const y0 = realSurface.heightAt(s.x, s.z);
    let maxSpeed = 0;
    run(realSurface, s, { throttle: 1, steer: 0, handbrake: false, neutral: false }, 22, DEFAULT_VEHICLE_PARAMS, 1 / 120, (st) => {
      if (st.speed > maxSpeed) maxSpeed = st.speed;
    });
    const y1 = realSurface.heightAt(s.x, s.z);
    tests.push({
      x: c.x,
      z: c.z,
      pendiente_local_deg: Number(slope.toFixed(1)),
      finalSpeed: Number(s.speed.toFixed(3)),
      maxSpeed: Number(maxSpeed.toFixed(2)),
      deltaY_m: Number((y1 - y0).toFixed(2)),
      subio: s.speed > 0.5 && y1 - y0 > 5,
    });
  }
  results.pendiente_max.real = {
    descripcion:
      'Terreno real: arranca DESDE PARADO en el punto, mirando a la máxima pendiente local, acelerador a fondo 22 s. ' +
      '"subió" = velocidad final > 0.5 m/s y ganó > 5 m de cota. OJO: las caras de 40° del DEM son cortas; con carrera ' +
      'se pueden "saltar" con energía cinética, por eso acá se arranca detenido.',
    pruebas: tests,
  };
}

// ====================== 2. Deslizamiento en bajada ===========================
function descentSynthetic(slopeDeg, params) {
  const surface = syntheticPlane(slopeDeg, 0);
  const yaw = Math.PI; // mira hacia -Z = pendiente abajo
  const s = createVehicleState(0, 0, yaw);
  let v1 = null;
  let v2 = null;
  let t1 = 0;
  let t2 = 0;
  run(surface, s, { throttle: 0, steer: 0, handbrake: false, neutral: true }, 6, params, 1 / 240, (st, t) => {
    if (t >= 1 && v1 === null) { v1 = st.speed; t1 = t; }
    if (t >= 5) { v2 = st.speed; t2 = t; }
  });
  const measured = (v2 - v1) / (t2 - t1);
  const ideal = GRAVITY * Math.sin((slopeDeg * Math.PI) / 180);
  return { measured, ideal, deviationPct: (100 * (measured - ideal)) / ideal };
}

{
  const tests = [];
  for (const a of [10, 15, 25, 40]) {
    const r = descentSynthetic(a, DEFAULT_VEHICLE_PARAMS);
    tests.push({
      pendiente_deg: a,
      aceleracion_medida_ms2: Number(r.measured.toFixed(3)),
      g_sin_theta_ms2: Number(r.ideal.toFixed(3)),
      desvio_pct: Number(r.deviationPct.toFixed(1)),
    });
  }
  results.bajada_punto_muerto.sintetico = {
    descripcion:
      'Punto muerto, sin acelerar, mirando pendiente abajo. Aceleración = Δv/Δt entre t=1 s y t=5 s.',
    perdidas: 'Crr·g·cosθ (rodadura) + arrastre aero. A baja velocidad manda la rodadura.',
    pruebas: tests,
  };
}

{
  const candidates = [
    { x: 3025, z: 3950, label: '22.4°' },
    { x: 3320, z: 3705, label: '40.5°' },
    { x: 2280, z: 4100, label: '32.6°' },
  ];
  const tests = [];
  for (const c of candidates) {
    const slope = localSlopeDeg(realSurface, c.x, c.z);
    const yaw = upSlopeYaw(realSurface, c.x, c.z) + Math.PI; // pendiente abajo
    const s = createVehicleState(c.x, c.z, yaw);
    let v1 = null;
    let v2 = null;
    run(realSurface, s, { throttle: 0, steer: 0, handbrake: false, neutral: true }, 4, DEFAULT_VEHICLE_PARAMS, 1 / 240, (st, t) => {
      if (t >= 0.5 && v1 === null) v1 = st.speed;
      if (t >= 3.5) v2 = st.speed;
    });
    const measured = (v2 - v1) / 3;
    const ideal = GRAVITY * Math.sin((slope * Math.PI) / 180);
    tests.push({
      punto: `x=${c.x} z=${c.z} (${c.label})`,
      pendiente_local_deg: Number(slope.toFixed(1)),
      aceleracion_medida_ms2: Number(measured.toFixed(3)),
      g_sin_theta_ms2: Number(ideal.toFixed(3)),
      desvio_pct: Number((100 * (measured - ideal) / ideal).toFixed(1)),
      velocidad_final_ms: Number(s.speed.toFixed(2)),
    });
  }
  results.bajada_punto_muerto.real = {
    descripcion: 'Punto muerto, sin acelerar, mirando pendiente abajo en el terreno real (4 s).',
    pruebas: tests,
  };
}

// ================== 3. Pérdida de tracción desde parado ======================
{
  const tests = [];
  for (const a of [25, 30, 35, 38, 40]) {
    const surface = syntheticPlane(a, 0);
    const s = createVehicleState(0, 0, 0);
    let sawSlipping = false;
    run(surface, s, { throttle: 1, steer: 0, handbrake: false, neutral: false }, 12, DEFAULT_VEHICLE_PARAMS, 1 / 120, (st) => {
      if (st.slipping) sawSlipping = true;
    });
    tests.push({
      pendiente_deg: a,
      velocidad_final_ms: Number(s.speed.toFixed(3)),
      patino_algun_momento: sawSlipping,
      resultado: s.speed > 0.3 ? 'sube' : s.speed < -0.3 ? 'resbala hacia atrás' : 'queda clavado',
    });
  }
  results.traccion_desde_parado.sintetico = {
    descripcion: 'Acelerador a fondo desde parado en plano inclinado, 12 s, sin freno de mano.',
    pruebas: tests,
  };
}

// ============================ 4. Estabilidad ================================
{
  const surface = syntheticPlane(0, 0); // llano
  const tests = [];
  for (const target of [5, 10, 15, 20, 25, 30]) {
    const s = createVehicleState(0, 0, 0);
    s.speed = target; // condición inicial de velocidad
    let maxLat = 0;
    let skidded = false;
    let rolled = false;
    run(surface, s, { throttle: 0, steer: 1, handbrake: false, neutral: false }, 3, DEFAULT_VEHICLE_PARAMS, 1 / 120, (st) => {
      const lat = Math.abs(st.lateralAccel);
      if (lat > maxLat) maxLat = lat;
      if (st.skidding) skidded = true;
      if (st.rolloverRisk) rolled = true;
    });
    tests.push({
      velocidad_inicial_ms: target,
      velocidad_inicial_kmh: Number((target * 3.6).toFixed(1)),
      max_aceleracion_lateral_ms2: Number(maxLat.toFixed(2)),
      derrapo: skidded,
      riesgo_vuelco: rolled,
    });
  }
  const latMaxFlat = DEFAULT_VEHICLE_PARAMS.gripLateral * GRAVITY;
  const rollover = ((DEFAULT_VEHICLE_PARAMS.track / 2) / DEFAULT_VEHICLE_PARAMS.cgHeight) * GRAVITY;
  results.estabilidad = {
    descripcion: 'Giro a fondo (steer=1) sobre llano. Se mide aceleración lateral, derrape y riesgo de vuelco.',
    max_aceleracion_lateral_teorica_ms2: Number(latMaxFlat.toFixed(2)),
    umbral_vuelco_llano_ms2: Number(rollover.toFixed(2)),
    conclusion: rollover > latMaxFlat ? 'en llano derrapa ANTES de volcar' : 'podría volcar',
    pruebas: tests,
  };

  // Ladera lateral: detenido, sin tocar nada, el coche debe escurrirse.
  const sideTests = [];
  for (const a of [30, 40, 45, 48]) {
    const sideSurface = syntheticPlane(a, 90); // sube hacia el Este (+X)
    const side = createVehicleState(0, 0, 0); // mirando al Norte, de costado a la pendiente
    let sideLat = 0;
    let sideRolled = false;
    run(sideSurface, side, { throttle: 0, steer: 0, handbrake: false, neutral: true }, 5, DEFAULT_VEHICLE_PARAMS, 1 / 120, (st) => {
      if (Math.abs(st.lateral) > sideLat) sideLat = Math.abs(st.lateral);
      if (st.rolloverRisk) sideRolled = true;
    });
    sideTests.push({
      pendiente_deg: a,
      velocidad_lateral_max_ms: Number(sideLat.toFixed(2)),
      se_escurre: sideLat > 0.5,
      riesgo_vuelco: sideRolled,
    });
  }
  results.estabilidad.ladera_lateral = {
    descripcion:
      'Plano sintético que sube al Este, vehículo mirando al Norte (de costado). Punto muerto, 5 s. ' +
      'Teoría: patina si tanθ > μ (≈38.7°) y vuelca si tanθ > (vía/2)/h_cg (≈46°).',
    umbral_escurrimiento_teorico_deg: (Math.atan(DEFAULT_VEHICLE_PARAMS.gripLateral) * 180) / Math.PI,
    umbral_vuelco_ladera_teorico_deg: (Math.atan((DEFAULT_VEHICLE_PARAMS.track / 2) / DEFAULT_VEHICLE_PARAMS.cgHeight) * 180) / Math.PI,
    pruebas: sideTests,
  };
}

// ============================== 5. Contacto =================================
{
  // Residual del plano de apoyo en el terreno real, sobre una grilla.
  // (El residual rueda-a-terreno con la transformación completa se mide en la app
  //  vía CDP; acá va el residual del ajuste de 4 puntos.)
  const { sampleAttitude } = await loadTs('src/vehicle/attitude.ts');
  const layout = { front: DEFAULT_VEHICLE_PARAMS.wheelBase / 2, rear: DEFAULT_VEHICLE_PARAMS.wheelBase / 2, halfTrack: DEFAULT_VEHICLE_PARAMS.track / 2 };
  let maxResidual = 0;
  let worst = null;
  const samples = [];
  for (let x = 200; x < 5800; x += 100) {
    for (let z = 200; z < 5800; z += 100) {
      const a = sampleAttitude(realSurface, x, z, 0.7, layout);
      if (a.maxResidual > maxResidual) { maxResidual = a.maxResidual; worst = { x, z }; }
    }
  }
  samples.push({ residual_max_m: Number(maxResidual.toFixed(4)), peor_punto: worst });
  results.contacto = {
    descripcion:
      'Residual del ajuste del plano de 4 puntos sobre el terreno real (grilla 100 m, yaw 0.7). ' +
      'Es la desviación no-planar del apoyo; el residual rueda-terreno de la app se mide en el navegador.',
    margen_declarado_m: 0.5,
    samples,
  };
}

writeFileSync(resolve(outDir, 'vehicle_measurements.json'), JSON.stringify(results, null, 2) + '\n');

// ------------------------------- Resumen -----------------------------------
console.log('=== 1. PENDIENTE MÁXIMA ===');
console.log(`  sintético: ${results.pendiente_max.sintetico.pendiente_max_escalable_deg}° (teoría atan(μ)=${results.teoria.pendiente_max_por_traccion_deg.toFixed(1)}°)`);
for (const p of results.pendiente_max.real.pruebas) {
  console.log(`  real ${p.pendiente_local_deg}° -> final ${p.finalSpeed} m/s, ΔY=${p.deltaY_m} m, ${p.subio ? 'SUBIÓ' : 'NO SUBIÓ'}`);
}
console.log('\n=== 2. BAJADA EN PUNTO MUERTO ===');
for (const p of results.bajada_punto_muerto.sintetico.pruebas) {
  console.log(`  ${p.pendiente_deg}°: medida=${p.aceleracion_medida_ms2} m/s² ideal=${p.g_sin_theta_ms2} desvío=${p.desvio_pct}%`);
}
for (const p of results.bajada_punto_muerto.real.pruebas) {
  console.log(`  real ${p.pendiente_local_deg}°: medida=${p.aceleracion_medida_ms2} ideal=${p.g_sin_theta_ms2} desvío=${p.desvio_pct}%`);
}
console.log('\n=== 3. TRACCIÓN DESDE PARADO ===');
for (const p of results.traccion_desde_parado.sintetico.pruebas) {
  console.log(`  ${p.pendiente_deg}°: ${p.resultado} (final ${p.velocidad_final_ms} m/s, patinó=${p.patino_algun_momento})`);
}
console.log('\n=== 4. ESTABILIDAD ===');
console.log(`  μ_lat·g=${results.estabilidad.max_aceleracion_lateral_teorica_ms2} m/s², vuelco=${results.estabilidad.umbral_vuelco_llano_ms2} m/s² -> ${results.estabilidad.conclusion}`);
for (const p of results.estabilidad.pruebas) {
  console.log(`  v=${p.velocidad_inicial_kmh} km/h: lat=${p.max_aceleracion_lateral_ms2} derrapó=${p.derrapo} vuelco=${p.riesgo_vuelco}`);
}
console.log(`  ladera lateral: umbral escurrimiento ${results.estabilidad.ladera_lateral.umbral_escurrimiento_teorico_deg.toFixed(1)}°, vuelco ${results.estabilidad.ladera_lateral.umbral_vuelco_ladera_teorico_deg.toFixed(1)}°`);
for (const p of results.estabilidad.ladera_lateral.pruebas) {
  console.log(`    ${p.pendiente_deg}°: v_lat=${p.velocidad_lateral_max_ms} m/s, escurre=${p.se_escurre}, vuelco=${p.riesgo_vuelco}`);
}
console.log('\n=== 5. CONTACTO ===');
console.log(`  residual máx del plano de 4 puntos: ${results.contacto.samples[0].residual_max_m} m en ${JSON.stringify(results.contacto.samples[0].peor_punto)}`);
console.log(`\n=> output/vehicle_measurements.json`);
