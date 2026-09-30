import './tiles-poc.css';
import { Color4 } from '@babylonjs/core/Maths/math.color';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight';
import { FreeCamera } from '@babylonjs/core/Cameras/freeCamera';
import { Engine } from '@babylonjs/core/Engines/engine';
import { Scene } from '@babylonjs/core/scene';
import { TilesRenderer } from '3d-tiles-renderer/babylonjs';

const canvas = document.querySelector<HTMLCanvasElement>('#renderCanvas');
const status = document.querySelector<HTMLElement>('#status');

if (!canvas || !status) throw new Error('No se encontró el canvas del visor 3D Tiles.');

const engine = new Engine(canvas, true, { preserveDrawingBuffer: true, stencil: true });
const scene = new Scene(engine);
scene.useRightHandedSystem = true;
scene.clearColor = new Color4(0.76, 0.84, 0.86, 1);

const camera = new FreeCamera('camera', new Vector3(4300, 2750, 1100), scene);
camera.upVector = new Vector3(0, 0, 1);
camera.setTarget(new Vector3(3200, 4000, 165));
camera.minZ = 0.5;
camera.maxZ = 12000;
camera.attachControl(canvas, true);
scene.activeCamera = camera;

const light = new HemisphericLight('sky', new Vector3(-0.2, -0.3, 1), scene);
light.intensity = 1.15;

const tiles = new TilesRenderer('/tiles-poc/tileset.json', scene);
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
scene.onBeforeRenderObservable.add(() => tiles.update());

engine.runRenderLoop(() => scene.render());
window.addEventListener('resize', () => engine.resize());
