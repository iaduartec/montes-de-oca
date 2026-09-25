// Página de VERIFICACIÓN aislada del objetivo (repetidor).
//
// Por qué existe: `src/main.ts` todavía NO instancia el objetivo —la integración
// de `window.__game.mission` la hace el orquestador—. Para poder VER el modelo
// antes de esa integración, esta página arma una escena mínima con el terreno
// REAL + el objetivo, sin tocar main.ts ni index.html.
//
// Uso: `npm run dev` y abrir /objective_preview.html, o capturar con
// `node scripts/gameplay/capture_objective.mjs`.
import { Engine } from '@babylonjs/core/Engines/engine';
import { Scene } from '@babylonjs/core/scene';
import { UniversalCamera } from '@babylonjs/core/Cameras/universalCamera';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight';
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color';
import { loadTerrainConfig } from '../../src/config';
import { loadTerrain } from '../../src/terrain';
import { createRepeaterObjective } from '../../src/gameplay/objective';
import { FIRST_ROUTE } from '../../src/gameplay/first-route';

const canvas = document.getElementById('render-canvas');
if (!(canvas instanceof HTMLCanvasElement)) throw new Error('falta #render-canvas');

const engine = new Engine(canvas, true, { preserveDrawingBuffer: true, stencil: true, antialias: true });
const scene = new Scene(engine);
scene.clearColor = new Color4(0.53, 0.68, 0.82, 1);

const ambient = new HemisphericLight('luz-ambiente', new Vector3(0.25, 1, 0.2), scene);
ambient.intensity = 0.65;
ambient.groundColor = new Color3(0.28, 0.3, 0.26);
const sun = new DirectionalLight('sol', new Vector3(-0.45, -1, -0.35), scene);
sun.intensity = 0.95;
sun.diffuse = new Color3(1, 0.97, 0.9);

const camera = new UniversalCamera('camara', new Vector3(0, 10, 0), scene);
camera.minZ = 0.3;
camera.maxZ = 40000;
camera.attachControl(canvas, true);

async function bootstrap(): Promise<void> {
  const config = await loadTerrainConfig();
  const terrain = await loadTerrain(scene, config);

  const at = { x: FIRST_ROUTE.target.x, z: FIRST_ROUTE.target.z, yaw: FIRST_ROUTE.targetYaw };
  const objective = createRepeaterObjective(scene, terrain, {
    at,
    clearRadiusM: FIRST_ROUTE.targetClearRadiusM,
  });

  // Cámara "desde la pista": 35 m atrás del objetivo sobre el tramo que llega.
  const waypoints = FIRST_ROUTE.waypoints;
  const previous = waypoints[waypoints.length - 2]!;
  const dx = at.x - previous.x;
  const dz = at.z - previous.z;
  const length = Math.hypot(dx, dz) || 1;
  const backX = at.x - (dx / length) * 35;
  const backZ = at.z - (dz / length) * 35;
  const groundY = terrain.heightAt(at.x, at.z);
  camera.position = new Vector3(backX, terrain.heightAt(backX, backZ) + 2.2, backZ);
  camera.setTarget(new Vector3(at.x, groundY + 5, at.z));
  terrain.cull(camera);

  // API de depuración para el CDP. Incluye un chequeo de "base apoya": las 9
  // alturas de la huella deben ser >= la Y del root (el mínimo), y el mínimo
  // debe coincidir con el root (si no, la losa flota en el aire).
  const half = 3.2;
  const cos = Math.cos(at.yaw);
  const sin = Math.sin(at.yaw);
  const footprint = (): { min: number; max: number; rootY: number; floating: boolean; samples: number[] } => {
    const offsets: readonly (readonly [number, number])[] = [
      [0, 0],
      [-half, -half],
      [half, -half],
      [-half, half],
      [half, half],
      [-half, 0],
      [half, 0],
      [0, -half],
      [0, half],
    ];
    const samples = offsets.map(([lx, lz]) => terrain.heightAt(at.x + lx * cos + lz * sin, at.z - lx * sin + lz * cos));
    const min = Math.min(...samples);
    const max = Math.max(...samples);
    const rootY = objective.root.position.y;
    return { min, max, rootY, floating: Math.abs(min - rootY) > 1e-6, samples };
  };

  (window as unknown as { __preview: unknown }).__preview = {
    ready: true,
    objective,
    setRepair: (p: number) => objective.setRepairProgress(p),
    target: at,
    groundY,
    footprint,
  };

  engine.runRenderLoop(() => {
    terrain.cull(camera);
    scene.render();
  });
  window.addEventListener('resize', () => engine.resize());
}

bootstrap().catch((error: unknown) => {
  console.error(error);
  const message = error instanceof Error ? error.message : String(error);
  document.title = `ERROR: ${message}`;
});
