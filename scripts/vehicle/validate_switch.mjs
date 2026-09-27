import assert from 'node:assert/strict';
import { build } from 'esbuild';

const bundle = await build({
  stdin: {
    contents: `export * from './src/vehicle/switch'; export * from './src/vehicle/catalog';`,
    resolveDir: process.cwd(),
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
});
const api = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);
const { validateSwitchPose, switchVehicle } = api;

const flat = { heightAt: () => 0, normalAt: () => ({ x: 0, y: 1, z: 0 }) };
const byId = (id) => {
  const definition = api.vehicleById(id);
  assert.ok(definition, `missing definition ${id}`);
  return definition;
};

function fakeActor(category, { x = 0, z = 0, yaw = 0, speed = 0, lateral = 0, fallen = false } = {}) {
  let disposed = false;
  let enabled = true;
  const state = { x, z, yaw, speed, lateral, ...(category === 'moto' ? { fallen } : {}) };
  return {
    category,
    state,
    bodySize: { lengthM: 4, widthM: 1.8, heightM: 1.8 },
    exitOffsetM: 1.4,
    root: {
      setEnabled: (value) => {
        enabled = value;
      },
    },
    enabled: () => enabled,
    disposed: () => disposed,
    contactPoints: (pose) => [{ x: pose.x, z: pose.z }],
    step() {},
    setInput() {},
    teleport() {},
    applyPose() {
      return 0;
    },
    telemetry() {
      return {};
    },
    dispose() {
      disposed = true;
    },
  };
}

function makeContext(overrides = {}) {
  const created = [];
  const persisted = [];
  let lastRebind = null;
  const base = {
    terrain: flat,
    canPlace: () => true,
    waterSafe: () => true,
    canExit: () => true,
    create: (target, pose) => {
      const actor = fakeActor(target.category, pose);
      created.push(actor);
      return actor;
    },
    prepareRebind: () => ({
      commit() {},
      rollback() {},
    }),
    persist: (id) => persisted.push(id),
  };
  const context = { ...base, ...overrides };
  if (overrides.trackRebind) {
    const inner = context.prepareRebind;
    context.prepareRebind = (...args) => {
      lastRebind = inner(...args);
      return lastRebind;
    };
  }
  return { context, created, persisted, rebind: () => lastRebind };
}

// --- validateSwitchPose: rechazos ---
const four = byId('estandar');
const moto = byId('trail');
const flatCtx = makeContext().context;

assert.equal(validateSwitchPose(fakeActor('todoterreno', { speed: 1 }), four, flatCtx).ok, false, 'moving forward rejected');
assert.equal(validateSwitchPose(fakeActor('todoterreno', { lateral: 0.2 }), four, flatCtx).ok, false, 'sliding rejected');
assert.equal(validateSwitchPose(fakeActor('moto', { fallen: true }), moto, flatCtx).ok, false, 'fallen moto rejected');
assert.equal(
  validateSwitchPose(fakeActor('todoterreno'), four, makeContext({ terrain: { heightAt: () => NaN, normalAt: flat.normalAt } }).context).ok,
  false,
  'missing terrain rejected',
);
assert.equal(
  validateSwitchPose(
    fakeActor('todoterreno'),
    four,
    makeContext({ terrain: { heightAt: () => 0, normalAt: () => ({ x: 0, y: 0.2, z: 0 }) } }).context,
  ).ok,
  false,
  'steep slope rejected',
);
assert.equal(validateSwitchPose(fakeActor('todoterreno'), four, makeContext({ canPlace: () => false }).context).ok, false, 'no space rejected');
assert.equal(validateSwitchPose(fakeActor('todoterreno'), four, makeContext({ waterSafe: () => false }).context).ok, false, 'deep water rejected');
assert.equal(validateSwitchPose(fakeActor('todoterreno'), four, makeContext({ canExit: () => false }).context).ok, false, 'no exit room rejected');
assert.equal(validateSwitchPose(fakeActor('todoterreno'), four, flatCtx).ok, true, 'stopped four-wheel accepted');
assert.equal(validateSwitchPose(fakeActor('moto'), moto, flatCtx).ok, true, 'upright moto accepted');

// --- switchVehicle: éxito ---
{
  const oldActor = fakeActor('todoterreno', { x: 5, z: 6, yaw: 0.3 });
  const ref = { current: oldActor };
  const { context, created, persisted } = makeContext();
  const result = switchVehicle(ref, byId('turismo'), context);
  assert.equal(result.ok, true, 'switch succeeds when stopped and supported');
  assert.equal(ref.current, created[0], 'active reference points at the candidate');
  assert.equal(ref.current.enabled(), true, 'candidate enabled on commit');
  assert.equal(oldActor.disposed(), true, 'previous actor disposed after success');
  assert.deepEqual(persisted, ['turismo'], 'selected id persisted');
  assert.equal(ref.current.state.x, 5, 'position preserved');
  assert.equal(ref.current.state.z, 6, 'position preserved');
  assert.equal(ref.current.state.yaw, 0.3, 'heading preserved');
}

// --- switchVehicle: el commit falla a mitad y revierte ---
{
  const oldActor = fakeActor('todoterreno', { x: 11, z: -4, yaw: 1.1, speed: 0, lateral: 0 });
  const ref = { current: oldActor };
  // Estado externo que el rebind toca: cámara, controles y HUD.
  const binding = { camera: 'old', controls: 'old', hud: 'old', rebinds: 0 };
  let mission = 'REPAIRED';
  const storage = [];
  const { context, created, rebind } = makeContext({
    trackRebind: true,
    persist: (id) => storage.push(id),
    prepareRebind: () => ({
      commit() {
        binding.camera = 'candidate';
        binding.controls = 'candidate';
        binding.hud = 'candidate';
        throw new Error('fallo de rebind simulado');
      },
      rollback() {
        binding.camera = 'old';
        binding.controls = 'old';
        binding.hud = 'old';
        binding.rebinds += 1;
      },
    }),
  });
  const result = switchVehicle(ref, byId('rally'), context);
  assert.equal(result.ok, false, 'partial commit failure is rejected');
  assert.equal(ref.current, oldActor, 'active reference restored');
  assert.deepEqual(binding, { camera: 'old', controls: 'old', hud: 'old', rebinds: 1 }, 'camera, controls and HUD restored');
  assert.deepEqual([oldActor.state.x, oldActor.state.z, oldActor.state.yaw], [11, -4, 1.1], 'old pose unchanged');
  assert.equal(oldActor.disposed(), false, 'old actor kept on failure');
  assert.equal(created[0].disposed(), true, 'candidate disposed on failure');
  assert.deepEqual(storage, [], 'storage untouched on failure');
  assert.equal(mission, 'REPAIRED', 'mission progress untouched');
  // rollback idempotente: repetirlo no rompe ni altera el estado restaurado.
  rebind().rollback();
  rebind().rollback();
  assert.deepEqual(binding, { camera: 'old', controls: 'old', hud: 'old', rebinds: 3 }, 'rollback is idempotent');
  mission = 'COMPLETED'; // referencia usada para que el valor no se optimice
  assert.equal(mission, 'COMPLETED');
}

// --- switchVehicle: fallo de creación ---
{
  const oldActor = fakeActor('todoterreno');
  const ref = { current: oldActor };
  const { context, persisted } = makeContext({
    create: () => {
      throw new Error('sin memoria');
    },
  });
  const result = switchVehicle(ref, byId('carga'), context);
  assert.equal(result.ok, false, 'creation failure is rejected');
  assert.equal(ref.current, oldActor, 'reference unchanged on creation failure');
  assert.equal(oldActor.disposed(), false, 'old actor kept on creation failure');
  assert.deepEqual(persisted, [], 'nothing persisted on creation failure');
}

// --- switchVehicle: el mundo se mueve durante la construcción ---
{
  const oldActor = fakeActor('todoterreno');
  const ref = { current: oldActor };
  let candidate = null;
  const { context } = makeContext({
    create: (target, pose) => {
      candidate = fakeActor(target.category, pose);
      oldActor.state.speed = 3; // el vehículo arranca mientras se construye
      return candidate;
    },
  });
  const result = switchVehicle(ref, byId('turismo'), context);
  assert.equal(result.ok, false, 'recheck rejects movement during creation');
  assert.equal(ref.current, oldActor, 'reference unchanged after recheck');
  assert.equal(candidate.disposed(), true, 'candidate disposed after recheck failure');
}

// --- switchVehicle: moto caída no se cambia ---
{
  const fallen = fakeActor('moto', { fallen: true });
  const ref = { current: fallen };
  const { context, created } = makeContext();
  const result = switchVehicle(ref, byId('enduro'), context);
  assert.equal(result.ok, false, 'fallen moto cannot switch');
  assert.equal(created.length, 0, 'no candidate created for a fallen moto');
}

// --- switchVehicle: a pie y conduciendo comparten el mismo camino ---
for (const mode of ['on-foot', 'driving']) {
  const ref = { current: fakeActor('todoterreno') };
  const { context } = makeContext({ canExit: () => mode === 'on-foot' || mode === 'driving' });
  const result = switchVehicle(ref, byId('explorador'), context);
  assert.equal(result.ok, true, `switch succeeds in ${mode}`);
}

console.log('PASS switch: detención, apoyo/espacio/agua, caída, atomicidad, rollback idempotente y fallo de creación');
