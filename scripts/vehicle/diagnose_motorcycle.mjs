import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
const baseline = process.argv.includes('--before');
const source = baseline ? 'outputs/driving-t2/motorcycle/motorcycle-physics.before.ts' : 'src/vehicle/motorcycle-physics.ts';
const bundle = await build({ stdin: { contents: `export * from './${source}'; export * from './src/vehicle/catalog';`, resolveDir: process.cwd() }, plugins: baseline ? [{ name: 'baseline-imports', setup(b) { b.onResolve({ filter: /^\.\/(physics|catalog|types)$/ }, args => ({ path: `${process.cwd()}/src/vehicle/${args.path.slice(2)}.ts` })); } }] : [], bundle: true, platform: 'node', format: 'esm', write: false });
const api = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);
const flat = { heightAt: () => 0, normalAt: () => ({ x: 0, y: 1, z: 0 }) };
const scenarios = [
  ['straight', 0, () => ({ throttle: 0.6, steer: 0 })],
  ['gentle-turn', 12, () => ({ throttle: 0.2, steer: 0.12 })],
  ['medium-turn', 12, () => ({ throttle: 0.2, steer: 0.4 })],
  ['slalom', 10, t => ({ throttle: 0.1, steer: 0.4 * Math.sin(t * Math.PI) })],
  ['brake-and-turn', 16, t => ({ throttle: t < 2 ? -0.4 : 0.2, steer: 0.4 })],
  ['low-speed-turn', 1, () => ({ throttle: 0, steer: 0.8 })],
  ['release-recovery', 12, t => ({ throttle: 0, steer: t < 2 ? 0.4 : 0 })],
];
const results = [];
for (const definition of api.VEHICLE_CATALOG.filter(d => d.category === 'moto')) {
  for (const [name, initialSpeed, controls] of scenarios) {
    const state = api.createMotorcycleState(0, 0); state.speed = initialSpeed;
    let maxRoll = 0, maxYawRate = 0, maxSpeed = 0, maxRollStep = 0, fallenAt = null;
    const samples = [];
    for (let i = 0; i < 600; i++) {
      const t = i / 60; const before = state.leanRad;
      api.stepMotorcycle(state, { handbrake: false, neutral: false, ...controls(t) }, 1 / 60, definition.params, flat);
      maxRoll = Math.max(maxRoll, Math.abs(state.leanRad)); maxYawRate = Math.max(maxYawRate, Math.abs(state.yawRate));
      maxSpeed = Math.max(maxSpeed, Math.abs(state.speed)); maxRollStep = Math.max(maxRollStep, Math.abs(state.leanRad - before));
      if (state.fallen && fallenAt === null) fallenAt = t;
      if (i % 6 === 0) samples.push({ t, roll: state.leanRad, speed: state.speed, yawRate: state.yawRate, fallen: state.fallen });
    }
    const record = { vehicle: definition.id, scenario: name, maxRollDeg: maxRoll * 180 / Math.PI, maxSpeedMps: maxSpeed, maxYawRate, maxRollStepDeg: maxRollStep * 180 / Math.PI, fallenAt, finalRollDeg: state.leanRad * 180 / Math.PI, samples };
    results.push(record);
    console.log(`${baseline ? 'BEFORE' : 'AFTER'} ${definition.id} ${name}: roll ${record.maxRollDeg.toFixed(2)}°, yaw ${maxYawRate.toFixed(3)} rad/s, speed ${maxSpeed.toFixed(2)} m/s, fallen ${fallenAt}`);
    if (!baseline) { assert.equal(state.fallen, false, `${definition.id} ${name}: ordinary riding must stay balanced`); assert.ok(maxRoll <= definition.params.leanLimitRad + 0.002, 'roll respects rider capacity'); if (name === 'release-recovery') assert.ok(Math.abs(state.leanRad) < 0.001, 'continuous return upright'); }
  }
}
if (!baseline) {
  for (const definition of api.VEHICLE_CATALOG.filter(d => d.category === 'moto')) {
    const p = definition.params;
    const returning = api.createMotorcycleState(0, 0); returning.leanRad = p.leanLimitRad;
    let previous = returning.leanRad;
    for (let i = 0; i < 120; i++) {
      api.stepMotorcycle(returning, { throttle: 0, steer: 0, handbrake: false, neutral: false }, 1 / 60, p, flat);
      assert.ok(returning.leanRad >= 0 && returning.leanRad <= previous, 'upright spring must not oscillate or snap');
      previous = returning.leanRad;
    }
    assert.ok(previous < 0.001, 'standing motorcycle recovers upright');
    const run = dt => {
      const state = api.createMotorcycleState(0, 0); state.speed = 12;
      for (let t = 0; t < 2 - 1e-8; t += dt) api.stepMotorcycle(state, { throttle: 0.2, steer: 0.4, handbrake: false, neutral: false }, dt, p, flat);
      return state;
    };
    const coarse = run(1 / 30); const fine = run(1 / 120);
    for (const field of ['x', 'z', 'speed', 'yawRate', 'leanRad']) assert.ok(Math.abs(coarse[field] - fine[field]) < 1e-8, `${field}: balance must be independent of frame grouping`);
    const sideGrade = 0.2;
    const banked = { heightAt: x => x * sideGrade, normalAt: () => ({ x: -sideGrade / Math.hypot(1, sideGrade), y: 1 / Math.hypot(1, sideGrade), z: 0 }) };
    const state = api.createMotorcycleState(0, 0); state.speed = 12;
    for (let i = 0; i < 600; i++) api.stepMotorcycle(state, { throttle: 0.1, steer: 0.4, handbrake: false, neutral: false }, 1 / 60, p, banked);
    assert.equal(state.fallen, false, 'supported side grade must not trigger false turn instability');
  }
}
mkdirSync('outputs/driving-t2/motorcycle', { recursive: true });
writeFileSync(`outputs/driving-t2/motorcycle/${baseline ? 'before' : 'after'}.json`, `${JSON.stringify({ source, kind: 'deterministic kinematic controller harness on flat support, not browser or hardware performance', results }, null, 2)}\n`);
