import { Engine } from '@babylonjs/core/Engines/engine';
import { Scene } from '@babylonjs/core/scene';
import { UniversalCamera } from '@babylonjs/core/Cameras/universalCamera';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight';
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color';
import { loadTerrainConfig, wgs84ToWorld } from './config';
import { createDiagnostics, formatVehicleHud, type DiagnosticsSnapshot } from './diagnostics';
import { auditVerticalDatum, loadTerrain, type WorldTerrain } from './terrain';
import { createVehicle, type Vehicle, type VehicleTelemetry } from './vehicle/index';
import { createVehicleControls } from './vehicle/controls';
import type { VehicleInput, VehicleParams } from './vehicle/physics';

const canvas = document.getElementById('render-canvas');
const hud = document.getElementById('hud');

if (!(canvas instanceof HTMLCanvasElement)) {
  throw new Error('No se encontró el canvas #render-canvas');
}

const engine = new Engine(canvas, true, {
  preserveDrawingBuffer: true,
  stencil: true,
  antialias: true,
});

const scene = new Scene(engine);
scene.clearColor = new Color4(0.53, 0.68, 0.82, 1);

// Iluminación mínima: ambiente + sol direccional desde el noroeste.
const ambient = new HemisphericLight('luz-ambiente', new Vector3(0.25, 1, 0.2), scene);
ambient.intensity = 0.65;
ambient.groundColor = new Color3(0.28, 0.3, 0.26);

const sun = new DirectionalLight('sol', new Vector3(-0.45, -1, -0.35), scene);
sun.intensity = 0.95;
sun.diffuse = new Color3(1, 0.97, 0.9);

const camera = new UniversalCamera('camara-libre', new Vector3(0, 80, -160), scene);
camera.attachControl(canvas, true);
camera.speed = 6;
camera.angularSensibility = 4000;
camera.inertia = 0.75;
camera.minZ = 0.5;
camera.maxZ = 40000;

/** Lee un número de la query string si es válido. */
function queryNumber(params: URLSearchParams, key: string): number | null {
  const raw = params.get(key);
  if (raw === null || raw.trim() === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function formatSnapshot(snapshot: DiagnosticsSnapshot, terrain: WorldTerrain): string {
  const center = terrain.center();
  return [
    `FPS        ${snapshot.fps.toFixed(0)}`,
    `frame      ${snapshot.frameTimeMs.toFixed(2)} ms`,
    `draw calls ${snapshot.drawCalls.toFixed(0)}`,
    `triángulos ${snapshot.triangles.toFixed(0)}`,
    `en vista   ${terrain.activeTriangles().toFixed(0)} (radio ${terrain.viewRadius.toFixed(0)} m)`,
    `vértices   ${snapshot.vertices.toFixed(0)}`,
    `mallas     ${snapshot.activeMeshes}`,
    `tiles      ${terrain.samplers.length}`,
    `centro     x=${center.x.toFixed(0)} z=${center.z.toFixed(0)} y=${center.height.toFixed(1)}`,
  ].join('\n');
}

/** API de depuración/medición expuesta en `window.__game` para CDP. */
interface DebugApi {
  terrainHeightAt(x: number, z: number): number;
  terrainNormalAt(x: number, z: number): { x: number; y: number; z: number };
  perf(): DiagnosticsSnapshot;
  auditDatum(): { verticalDatum: number; maxAbsDiffM: number; ok: boolean; samples: readonly unknown[] };
  vehicle: {
    telemetry(): VehicleTelemetry;
    setInput(input: VehicleInput | null): void;
    teleport(x: number, z: number, yaw: number): void;
    setState(partial: Partial<{ x: number; z: number; yaw: number; speed: number; lateral: number }>): void;
    setParams(partial: Partial<VehicleParams>): void;
    params(): VehicleParams;
    step(seconds: number, dt?: number): void;
    reset(): void;
  } | null;
}

declare global {
  interface Window {
    __game?: DebugApi;
  }
}

function showError(message: string): void {
  console.error(message);
  if (hud) {
    hud.textContent = `ERROR\n${message}`;
    hud.classList.add('hud-error');
  }
}

async function bootstrap(): Promise<void> {
  const config = await loadTerrainConfig();
  const terrain = await loadTerrain(scene, config);

  const params = new URLSearchParams(window.location.search);

  // Punto de aparición: el config trae el pueblo en WGS84; si no, el centro.
  const center = terrain.center();
  let spawnX = center.x;
  let spawnZ = center.z;
  if (config.spawn) {
    const [worldX, worldZ] = wgs84ToWorld(config, config.spawn.lon, config.spawn.lat);
    spawnX = worldX;
    spawnZ = worldZ;
  }

  // La cámara libre histórica se activa con px/py/pz (capturas de terreno). Sin
  // esos parámetros arranca el MODO VEHÍCULO con cámara de persecución.
  const px = queryNumber(params, 'px');
  const py = queryNumber(params, 'py');
  const pz = queryNumber(params, 'pz');
  const tx = queryNumber(params, 'tx');
  const ty = queryNumber(params, 'ty');
  const tz = queryNumber(params, 'tz');
  const freeCamera = px !== null || py !== null || pz !== null;

  // ----- Auditoría del footgun de los dos heightAt (ver src/terrain.ts) -----
  const auditPoints: { x: number; z: number }[] = [];
  for (const sampler of terrain.samplers) {
    const grid = sampler.grid;
    const midX = grid.x0 + ((grid.columns - 1) * grid.dx) / 2;
    const midZ = grid.z0 + ((grid.rows - 1) * grid.dz) / 2;
    auditPoints.push({ x: midX, z: midZ });
  }
  auditPoints.push({ x: spawnX, z: spawnZ });
  const datumAudit = auditVerticalDatum(terrain, auditPoints);
  console.info(
    `[datum] verticalDatum=${datumAudit.verticalDatum} muestras=${datumAudit.samples.length} ` +
      `diff_max=${datumAudit.maxAbsDiffM.toExponential(2)} => ${datumAudit.ok ? 'OK' : 'FALLA'}`,
  );
  console.assert(datumAudit.ok, 'Los dos heightAt NO difieren exactamente en el verticalDatum', datumAudit);
  if (!datumAudit.ok) {
    throw new Error(`Auditoría de datum FALLÓ (diff max ${datumAudit.maxAbsDiffM} m)`);
  }

  let vehicle: Vehicle | null = null;
  let controls: ReturnType<typeof createVehicleControls> | null = null;
  let manualStep = false;

  const groundY = terrain.heightAt(spawnX, spawnZ);

  if (freeCamera) {
    camera.position = new Vector3(px ?? spawnX, py ?? groundY + 100, pz ?? spawnZ - 40);
    const target = new Vector3(tx ?? spawnX, ty ?? groundY - 15, tz ?? spawnZ + 480);
    camera.setTarget(target);
  } else {
    camera.detachControl();
    const yaw = queryNumber(params, 'vyaw') ?? 0;
    controls = createVehicleControls({
      onReset: () => vehicle?.teleport(spawnX, spawnZ, yaw),
    });
    vehicle = createVehicle({ scene, terrain, spawn: { x: spawnX, z: spawnZ, yaw }, controls });
    // Posición de cámara inicial detrás del vehículo.
    camera.position = new Vector3(spawnX - Math.sin(yaw) * 7.5, terrain.heightAt(spawnX, spawnZ) + 2.4, spawnZ - Math.cos(yaw) * 7.5);
    camera.minZ = 0.3;
  }

  window.addEventListener('resize', () => engine.resize());

  const diagnostics = createDiagnostics(scene);
  let hudTick = 0;

  terrain.cull(camera);

  const updateChaseCamera = (dt: number): void => {
    if (!vehicle) return;
    const state = vehicle.state;
    const fx = Math.sin(state.yaw);
    const fz = Math.cos(state.yaw);
    const car = vehicle.root.position;
    const desired = new Vector3(car.x - fx * 7.5, car.y + 2.4, car.z - fz * 7.5);
    const k = 1 - Math.exp(-dt * 5);
    camera.position = Vector3.Lerp(camera.position, desired, k);
    const target = new Vector3(car.x + fx * 1.8, car.y + 0.85, car.z + fz * 1.8);
    camera.setTarget(target);
  };

  engine.runRenderLoop(() => {
    const dt = engine.getDeltaTime() / 1000;
    if (vehicle && !manualStep) vehicle.step(dt);
    updateChaseCamera(dt);
    terrain.cull(camera);
    scene.render();
    hudTick++;
    if (hud && hudTick % 5 === 0) {
      const perf = formatSnapshot(diagnostics.snapshot(), terrain);
      const veh = vehicle ? formatVehicleHud(vehicle.telemetry()) : '';
      const keys = vehicle ? 'W/S acelerar-frenar · A/D girar · Espacio freno de mano · N punto muerto · R reposicionar' : '';
      hud.textContent = [perf, veh, keys].filter((block) => block.length > 0).join('\n\n');
    }
  });

  // ----- API de medición (CDP / capturas) -----
  const debugVehicle = vehicle
    ? {
        telemetry: () => vehicle!.telemetry(),
        setInput: (input: VehicleInput | null) => vehicle!.setInput(input),
        teleport: (x: number, z: number, yaw: number) => vehicle!.teleport(x, z, yaw),
        setState: (partial: Partial<{ x: number; z: number; yaw: number; speed: number; lateral: number }>) => {
          const s = vehicle!.state;
          if (partial.x !== undefined) s.x = partial.x;
          if (partial.z !== undefined) s.z = partial.z;
          if (partial.yaw !== undefined) s.yaw = partial.yaw;
          if (partial.speed !== undefined) s.speed = partial.speed;
          if (partial.lateral !== undefined) s.lateral = partial.lateral;
          vehicle!.applyPose();
        },
        setParams: (partial: Partial<VehicleParams>) => Object.assign(vehicle!.params, partial),
        params: () => ({ ...vehicle!.params }),
        step: (seconds: number, dt = 1 / 60) => {
          manualStep = true;
          const steps = Math.max(1, Math.round(seconds / dt));
          for (let i = 0; i < steps; i++) vehicle!.step(dt);
        },
        reset: () => {
          manualStep = false;
          vehicle!.setInput(null);
          vehicle!.teleport(spawnX, spawnZ, queryNumber(params, 'vyaw') ?? 0);
        },
      }
    : null;

  window.__game = {
    terrainHeightAt: (x, z) => terrain.heightAt(x, z),
    terrainNormalAt: (x, z) => {
      const n = terrain.normalAt(x, z);
      return { x: n.x, y: n.y, z: n.z };
    },
    perf: () => diagnostics.snapshot(),
    auditDatum: () => ({
      verticalDatum: datumAudit.verticalDatum,
      maxAbsDiffM: datumAudit.maxAbsDiffM,
      ok: datumAudit.ok,
      samples: datumAudit.samples,
    }),
    vehicle: debugVehicle,
  };

  window.addEventListener('beforeunload', () => {
    controls?.dispose();
    vehicle?.dispose();
    diagnostics.dispose();
    terrain.dispose();
    engine.dispose();
  });
}

bootstrap().catch((error: unknown) => {
  showError(error instanceof Error ? error.message : String(error));
});
