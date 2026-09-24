import { Engine } from '@babylonjs/core/Engines/engine';
import { Scene } from '@babylonjs/core/scene';
import { UniversalCamera } from '@babylonjs/core/Cameras/universalCamera';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight';
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color';
import { loadTerrainConfig, wgs84ToWorld } from './config';
import { createDiagnostics, type DiagnosticsSnapshot } from './diagnostics';
import { loadTerrain, type WorldTerrain } from './terrain';

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
    `cámara     x=${camera.position.x.toFixed(0)} y=${camera.position.y.toFixed(0)} z=${camera.position.z.toFixed(0)}`,
  ].join('\n');
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
  const groundY = terrain.heightAt(spawnX, spawnZ);

  // Posición/objetivo por query (para capturas reproducibles) o vista por defecto.
  const px = queryNumber(params, 'px');
  const py = queryNumber(params, 'py');
  const pz = queryNumber(params, 'pz');
  const tx = queryNumber(params, 'tx');
  const ty = queryNumber(params, 'ty');
  const tz = queryNumber(params, 'tz');

  camera.position = new Vector3(px ?? spawnX, py ?? groundY + 100, pz ?? spawnZ - 40);
  const target = new Vector3(tx ?? spawnX, ty ?? groundY - 15, tz ?? spawnZ + 480);
  camera.setTarget(target);

  window.addEventListener('resize', () => engine.resize());

  const diagnostics = createDiagnostics(scene);
  let hudTick = 0;

  // Primer culling antes de renderizar y en cada frame (36 AABB: trivial).
  terrain.cull(camera);

  engine.runRenderLoop(() => {
    terrain.cull(camera);
    scene.render();
    hudTick++;
    if (hud && hudTick % 10 === 0) {
      hud.textContent = formatSnapshot(diagnostics.snapshot(), terrain);
    }
  });

  window.addEventListener('beforeunload', () => {
    diagnostics.dispose();
    terrain.dispose();
    engine.dispose();
  });
}

bootstrap().catch((error: unknown) => {
  showError(error instanceof Error ? error.message : String(error));
});
