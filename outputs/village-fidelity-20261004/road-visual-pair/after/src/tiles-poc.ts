import './tiles-poc.css';
import { Color4 } from '@babylonjs/core/Maths/math.color';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight';
import { FreeCamera } from '@babylonjs/core/Cameras/freeCamera';
import { Engine } from '@babylonjs/core/Engines/engine';
import '@babylonjs/core/Engines/Extensions/engine.query';
import { Scene } from '@babylonjs/core/scene';
import { Frustum } from '@babylonjs/core/Maths/math.frustum';
import { SceneInstrumentation } from '@babylonjs/core/Instrumentation/sceneInstrumentation';
// Register PBR shaders up front. Babylon's lazy shader imports fail under the
// minimal isolated Vite harness when optimized from a temporary cache path.
import '@babylonjs/core/Shaders/pbr.vertex';
import '@babylonjs/core/Shaders/pbr.fragment';
import { TilesRenderer } from '3d-tiles-renderer/babylonjs';
import { parseTerrainConfig } from './config';
import { loadTerrain } from './terrain';

const canvas = document.querySelector<HTMLCanvasElement>('#renderCanvas');
const status = document.querySelector<HTMLElement>('#status');

if (!canvas || !status) throw new Error('No se encontró el canvas del visor 3D Tiles.');

const engine = new Engine(canvas, true, { preserveDrawingBuffer: true, stencil: true });
const scene = new Scene(engine);
scene.useRightHandedSystem = true;
scene.clearColor = new Color4(0.76, 0.84, 0.86, 1);

const params = new URLSearchParams(location.search);
const benchmarkMode = params.get('benchmark') === '1';
const benchmarkRenderer = params.get('renderer') === 'terrain' ? 'terrain' : 'tiles';
const camera = new FreeCamera('camera', new Vector3(
  Number(params.get('x') ?? 4300), Number(params.get('y') ?? 2750), Number(params.get('z') ?? 1100),
), scene);
// The Babylon 3D Tiles renderer traverses in its documented Z-up tile frame.
camera.upVector = new Vector3(0, 0, 1);
camera.setTarget(new Vector3(
  Number(params.get('tx') ?? 3200), Number(params.get('ty') ?? 4000), Number(params.get('tz') ?? 165),
));
camera.minZ = 0.5;
camera.maxZ = benchmarkMode ? 4000 : 12000;
camera.fov = 0.8;
camera.attachControl(canvas, true);
scene.activeCamera = camera;

const light = new HemisphericLight('sky', new Vector3(-0.2, -0.3, 1), scene);
light.intensity = 1.15;

const renderTimes: number[] = [];
const drawCallsPerFrame: number[] = [];
const instrumentation = new SceneInstrumentation(scene);
let renderStart = 0;
scene.onBeforeRenderObservable.add(() => {
  renderStart = performance.now();
  instrumentation.drawCallsCounter.fetchNewFrame();
});
scene.onAfterRenderObservable.add(() => {
  if (benchmarkMode) {
    renderTimes.push(performance.now() - renderStart);
    drawCallsPerFrame.push(instrumentation.drawCallsCounter.current);
    if (renderTimes.length > 2048) renderTimes.shift();
    if (drawCallsPerFrame.length > 2048) drawCallsPerFrame.shift();
  }
});
const gpuTimerQueryAvailable = Boolean(engine.getCaps().timerQuery);
engine.captureGPUFrameTime(gpuTimerQueryAvailable);

let tiles: TilesRenderer | null = null;
let terrain: Awaited<ReturnType<typeof loadTerrain>> | null = null;
if (benchmarkMode) {
  Object.assign(window, { __tilesBenchmark: {
    scene, camera, engine, renderer: benchmarkRenderer, tiles, terrain, renderTimes, drawCallsPerFrame,
    frustumPlanes: () => {
      camera.getViewMatrix(true);
      camera.getProjectionMatrix(true);
      return Frustum.GetPlanes(camera.getTransformationMatrix());
    },
  } });
  try {
    if (benchmarkRenderer === 'terrain') {
      const response = await fetch('/terrain/config.json');
      if (!response.ok) throw new Error(`terrain config HTTP ${response.status}`);
      const config = parseTerrainConfig(await response.json());
      const tileId = params.get('tile') ?? 'tile_3_3';
      const selected = config.tiles.find((tile) => tile.id === tileId);
      if (!selected) throw new Error(`unknown benchmark tile ${tileId}`);
      terrain = await loadTerrain(scene, { ...config, tiles: [selected], viewRadius: 1500 });
      // Put the gameplay Y-up mesh into the same Z-up frame as the tile renderer.
      for (const mesh of terrain.meshes) {
        mesh.rotation.x = Math.PI / 2;
        mesh.computeWorldMatrix(true);
        mesh.setEnabled(true);
      }
      status.textContent = `Gameplay terrain ${tileId} ready`;
    } else {
      tiles = new TilesRenderer('/tiles-benchmark/equivalent/tileset.json', scene);
      tiles.addEventListener('load-model', () => { status.textContent = '3D Tiles exact gameplay tile ready'; });
      tiles.addEventListener('load-root-tileset', () => { status.textContent = '3D Tiles tileset ready; loading content…'; });
      tiles.addEventListener('load-error', (event) => {
        console.error('[tiles-benchmark] Tiles load failed', event.error);
        status.textContent = `3D Tiles load error: ${String(event.error ?? 'unknown error')}`;
      });
      scene.onBeforeRenderObservable.add(() => tiles?.update());
    }
    Object.assign(window, { __tilesBenchmark: {
      scene, camera, engine, renderer: benchmarkRenderer, tiles, terrain, renderTimes, drawCallsPerFrame,
      frustumPlanes: () => {
        camera.getViewMatrix(true);
        camera.getProjectionMatrix(true);
        return Frustum.GetPlanes(camera.getTransformationMatrix());
      },
    } });
  } catch (error) {
    console.error('[tiles-benchmark] benchmark scene setup failed', error);
    status.textContent = 'Benchmark setup error';
  }
} else {
  // Keep the original 3 km / 10 m proof of concept intact for manual review.
  camera.upVector = new Vector3(0, 0, 1);
  camera.setTarget(new Vector3(3200, 4000, 165));
  camera.maxZ = 12000;
  camera.fov = 0.8;
  light.direction.set(-0.2, -0.3, 1);
  tiles = new TilesRenderer('/tiles-poc/tileset.json', scene);
  Object.assign(window, { __tilesPoc: { scene, camera, tiles } });
  tiles.addEventListener('load-model', () => {
    status.textContent = 'Tesela 3 × 3 km cargada · arrastra para orbitar · rueda para acercar';
  });
  tiles.addEventListener('load-root-tileset', () => {
    status.textContent = 'Conjunto cartográfico listo · cargando tesela visible…';
  });
  tiles.addEventListener('load-error', (event) => {
    console.error('[tiles-poc] No se pudo cargar 3D Tiles', event.error);
    status.textContent = 'Error cargando los archivos locales; revisa la consola.';
  });
  scene.onBeforeRenderObservable.add(() => tiles?.update());
}

window.addEventListener('beforeunload', () => {
  instrumentation.dispose();
  tiles?.dispose();
  terrain?.dispose();
  scene.dispose();
  engine.dispose();
}, { once: true });

engine.runRenderLoop(() => scene.render());
window.addEventListener('resize', () => engine.resize());
