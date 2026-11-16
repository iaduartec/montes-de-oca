import { Engine } from '@babylonjs/core/Engines/engine';
import { UniversalCamera } from '@babylonjs/core/Cameras/universalCamera';
import { Color4 } from '@babylonjs/core/Maths/math.color';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { Scene } from '@babylonjs/core/scene';

/** Crea el motor, la escena principal y la cámara libre histórica del juego. */
export function createRenderingRuntime(canvas: HTMLCanvasElement) {
  const engine = new Engine(canvas, true, {
    preserveDrawingBuffer: true,
    stencil: true,
    antialias: true,
  });

  const scene = new Scene(engine);
  scene.clearColor = new Color4(0.53, 0.68, 0.82, 1);

  // La cámara libre histórica también sirve como base del modo de conducción.
  const camera = new UniversalCamera('camara-libre', new Vector3(0, 80, -160), scene);
  camera.attachControl(canvas, true);
  camera.speed = 6;
  camera.angularSensibility = 4000;
  camera.inertia = 0.75;
  camera.minZ = 0.5;
  camera.maxZ = 40000;

  return { engine, scene, camera };
}
