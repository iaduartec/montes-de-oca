import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const bundlePath = resolve('scripts/vehicle/.test_suspension_actor.bundle.mjs');
const bundle = await build({
  entryPoints: ['src/vehicle/four-wheel.ts'], bundle: true,
  platform: 'node', format: 'esm', write: false,
  plugins: [{
    name: 'babylon-node-extensions',
    setup(buildApi) {
      buildApi.onResolve({ filter: /^@babylonjs\/core\// }, ({ path }) => ({
        path: path.endsWith('.js') ? path : `${path}.js`, external: true,
      }));
    },
  }],
});
writeFileSync(bundlePath, bundle.outputFiles[0].contents);
const actorModule = await import(pathToFileURL(bundlePath).href);
const { NullEngine } = await import('@babylonjs/core/Engines/nullEngine.js');
const { Scene } = await import('@babylonjs/core/scene.js');
const { SceneLoader } = await import('@babylonjs/core/Loading/sceneLoader.js');
const { TransformNode } = await import('@babylonjs/core/Meshes/transformNode.js');
const { MeshBuilder } = await import('@babylonjs/core/Meshes/meshBuilder.js');
const { PBRMaterial } = await import('@babylonjs/core/Materials/PBR/pbrMaterial.js');

const engine = new NullEngine();
const scene = new Scene(engine);
const originalLoader = SceneLoader.LoadAssetContainerAsync;
let finishAssetLoad;
SceneLoader.LoadAssetContainerAsync = () => new Promise((resolve) => {
  finishAssetLoad = resolve;
  // Deliberately hold resolution until after wheel compression has changed.
});

function planeSurface(slopeX = 0, slopeZ = 0) {
  const norm = Math.hypot(slopeX, 1, slopeZ);
  return {
    heightAt: (x, z) => slopeX * x + slopeZ * z,
    normalAt: () => ({ x: -slopeX / norm, y: 1 / norm, z: -slopeZ / norm }),
  };
}

function asymmetricBump() {
  const plane = planeSurface();
  return {
    ...plane,
    heightAt: (x, z) => x < -0.5 && z > 0.7 ? 0.18 : 0,
  };
}

function rampEdge() {
  const plane = planeSurface();
  return {
    ...plane,
    heightAt: (_x, z) => Math.max(0, Math.min(0.18, (z + 0.45) * 0.18)),
    normalAt: (_x, z) => {
      const slope = z > -0.45 && z < 0.55 ? 0.18 : 0;
      const norm = Math.hypot(1, slope);
      return { x: 0, y: 1 / norm, z: -slope / norm };
    },
  };
}

async function makeDelayedAsset() {
  const root = new TransformNode('utility-root', scene);
  const pivots = ['wheel-lf', 'wheel-rf', 'wheel-lr', 'wheel-rr'].map((name) => {
    const node = new TransformNode(name, scene);
    node.parent = root;
    return node;
  });
  const meshes = Array.from({ length: 10 }, (_, index) => {
    const mesh = MeshBuilder.CreateBox(`utility-shell-${index}`, { size: 0.1 }, scene);
    mesh.parent = root;
    return mesh;
  });
  const orange = new PBRMaterial('orange', scene);
  const container = {
    transformNodes: [root, ...pivots], rootNodes: [root], meshes, materials: [orange], animationGroups: [],
    addAllToScene() {}, dispose() {},
  };
  finishAssetLoad(container);
}

try {
  const explorador = { id: 'explorador', name: 'Explorador', summary: '', category: 'coche', visual: 'explorador',
    bodySize: { lengthM: 3.9, widthM: 1.8, heightM: 1.85 }, exitOffsetM: 1.4,
    params: { mass: 1550, wheelBase: 2.5, track: 1.54, maxDriveForce: 15500, maxSpeed: 30, grip: 0.88 } };
  const standard = { id: 'estandar', name: 'Estándar', summary: '', category: 'todoterreno', visual: 'estandar',
    bodySize: { lengthM: 4.2, widthM: 1.9, heightM: 1.9 }, exitOffsetM: 1.45, params: {} };
  const makeVehicle = (terrain, definition = explorador) =>
    actorModule.createFourWheelVehicle({ scene, terrain, spawn: { x: 0, z: 0, yaw: 0 } }, definition);

  const flatVehicle = makeVehicle(planeSurface());
  assert.ok(flatVehicle.telemetry().wheelResidualMaxM < 0.01, 'flat terrain wheel contact residual');
  assert.ok(flatVehicle.telemetry().wheelCompression.every((value) => Math.abs(value - 0.12) < 1e-6), 'flat terrain uses mid travel');
  flatVehicle.dispose();

  const slopeVehicle = makeVehicle(planeSurface(0.08, 0.12));
  const slope = slopeVehicle.telemetry();
  assert.ok(slope.wheelResidualMaxM < 0.003, 'planar slope preserves wheel contact');
  assert.ok(slope.wheelCompression.every((value) => Math.abs(value - 0.12) < 0.01), 'planar slope is not counted again as wheel compression');
  slopeVehicle.dispose();

  const bumpVehicle = makeVehicle(asymmetricBump());
  bumpVehicle.step(1 / 60);
  const bump = bumpVehicle.telemetry();
  assert.ok(bump.wheelCompression[0] > bump.wheelCompression[1] + 0.06, 'asymmetric bump compresses only its wheel');
  assert.ok(bump.wheelResidualMaxM < 0.003, 'bump wheel remains within contact travel');
  bumpVehicle.dispose();

  // Run over a ramp edge: body attitude is damped across multiple frames, but
  // wheel travel is corrected against that actual body plane each frame.
  const transitionVehicle = makeVehicle(rampEdge());
  transitionVehicle.setInput({ throttle: 0.45, steer: 0, handbrake: false, neutral: false });
  let maxTransitionResidual = 0;
  let maxTransitionCompression = 0;
  for (let frame = 0; frame < 90; frame++) {
    transitionVehicle.step(1 / 60);
    const telemetry = transitionVehicle.telemetry();
    maxTransitionResidual = Math.max(maxTransitionResidual, telemetry.wheelResidualMaxM);
    maxTransitionCompression = Math.max(maxTransitionCompression, ...telemetry.wheelCompression);
    assert.ok(telemetry.wheelCompression.every((value) => value >= 0 && value <= 0.24), 'transition wheel travel remains bounded');
  }
  assert.ok(maxTransitionResidual < 0.003, `ramp transition wheel contact residual ${maxTransitionResidual}`);
  assert.ok(maxTransitionCompression > 0.12, 'ramp edge produces measurable wheel travel');
  assert.ok(!transitionVehicle.telemetry().airborne, 'supported ramp does not report airborne');
  transitionVehicle.dispose();

  // The utility GLB is intentionally delayed. Compression changes before its
  // four real pivots arrive, then the async replacement must inherit the latest
  // wheel state and preserve the measured terrain contacts.
  const glbVehicle = makeVehicle(asymmetricBump(), standard);
  glbVehicle.step(1 / 60);
  const beforeSwap = glbVehicle.telemetry();
  assert.ok(beforeSwap.wheelCompression[0] > beforeSwap.wheelCompression[1] + 0.06);
  await makeDelayedAsset();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const afterSwap = glbVehicle.telemetry();
  assert.ok(afterSwap.wheelResidualMaxM < 0.005, `delayed GLB contact residual ${afterSwap.wheelResidualMaxM}`);
  assert.ok(afterSwap.wheelCompression[0] > afterSwap.wheelCompression[1] + 0.06, 'delayed GLB inherits current wheel travel');
  glbVehicle.dispose();

  console.log(`PASS NullEngine vehicle suspension: flat=${slope.wheelResidualMaxM.toFixed(4)} m plane, bump=${bump.wheelResidualMaxM.toFixed(4)} m, ramp transition max=${maxTransitionResidual.toFixed(4)} m, GLB swap=${afterSwap.wheelResidualMaxM.toFixed(4)} m`);
} finally {
  SceneLoader.LoadAssetContainerAsync = originalLoader;
  scene.dispose();
  engine.dispose();
  rmSync(bundlePath, { force: true });
}
