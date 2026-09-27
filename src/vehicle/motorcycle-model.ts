import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import type { Scene } from '@babylonjs/core/scene';
import type { MotorcycleDefinition } from './catalog';

/** Frame, rider anchors and independently supported front/rear wheels. */
export function createMotorcycleModel(scene: Scene, definition: MotorcycleDefinition) {
  const { params, visual } = definition;
  const root = new TransformNode(`motorcycle:${visual}`, scene);
  const frame = new TransformNode('motorcycle:frame', scene); frame.parent = root;
  const material = (name: string, color: string): StandardMaterial => {
    const m = new StandardMaterial(`motorcycle:${name}`, scene);
    m.diffuseColor = Color3.FromHexString(color); m.specularColor.set(0.15, 0.15, 0.15); return m;
  };
  const paint = material('paint', visual === 'trail' ? '#de8b30' : '#4caa53');
  const dark = material('rubber-seat', '#20252b'); const metal = material('metal', '#85919a');
  const box = (name: string, width: number, height: number, depth: number, x: number, y: number, z: number, mat = paint) => {
    const mesh = MeshBuilder.CreateBox(`motorcycle:${name}`, { width, height, depth }, scene);
    mesh.parent = frame; mesh.position.set(x, y, z); mesh.material = mat; return mesh;
  };
  const trail = visual === 'trail';
  box(`body-${visual}`, trail ? 0.48 : 0.3, trail ? 0.42 : 0.27, 0.65, 0, 0.78, 0.14);
  box('engine', 0.3, 0.32, 0.43, 0, 0.45, 0, metal);
  box('seat', trail ? 0.37 : 0.24, 0.12, trail ? 0.65 : 0.85, 0, 0.91, -0.3, dark);
  box('rear-fender', 0.28, 0.07, 0.6, 0, 0.8, -0.72);
  box('front-fender', 0.24, 0.06, 0.6, 0, trail ? 0.79 : 0.91, params.wheelBase / 2);
  if (trail) {
    box('windscreen', 0.39, 0.38, 0.055, 0, 1.16, 0.55, metal).rotation.x = -0.22;
    box('luggage-left', 0.22, 0.32, 0.45, -0.35, 0.75, -0.57, dark);
    box('luggage-right', 0.22, 0.32, 0.45, 0.35, 0.75, -0.57, dark);
  } else box('number-plate', 0.28, 0.3, 0.04, 0, 1.03, 0.6, metal);
  const handlebar = box('handlebar', definition.bodySize.widthM, 0.045, 0.07, 0, 1.08, 0.47, metal);
  for (const side of [-1, 1]) {
    box('fork', 0.045, 0.62, 0.045, side * 0.12, 0.59, params.wheelBase / 2, metal).rotation.x = -0.15;
    box('footpeg', 0.19, 0.04, 0.09, side * 0.22, 0.48, -0.1, metal);
  }
  const wheels = [1, -1].map(sign => {
    const hub = new TransformNode(`motorcycle:wheel-${sign === 1 ? 'front' : 'rear'}`, scene); hub.parent = root;
    hub.position.z = sign * params.wheelBase / 2;
    const spin = new TransformNode('motorcycle:wheel-spin', scene); spin.parent = hub;
    const tire = MeshBuilder.CreateCylinder('motorcycle:tire', { diameter: params.wheelRadius * 2, height: 0.14, tessellation: 20 }, scene);
    tire.parent = spin; tire.rotation.z = Math.PI / 2; tire.material = dark;
    const rim = MeshBuilder.CreateCylinder('motorcycle:rim', { diameter: params.wheelRadius * 1.3, height: 0.15, tessellation: 12 }, scene);
    rim.parent = spin; rim.rotation.z = Math.PI / 2; rim.material = metal;
    // A visible spoke makes actual wheel rotation readable.
    const spoke = MeshBuilder.CreateBox('motorcycle:spoke', { width: 0.16, height: params.wheelRadius * 1.4, depth: 0.025 }, scene);
    spoke.parent = spin; spoke.material = metal;
    return { hub, spin };
  });
  const riderSeat = new TransformNode('motorcycle:rider-seat', scene); riderSeat.parent = frame; riderSeat.position.set(0, 0.98, -0.23);
  const riderHands = new TransformNode('motorcycle:rider-hands', scene); riderHands.parent = frame; riderHands.position.set(0, 1.08, 0.47);
  const riderFeet = new TransformNode('motorcycle:rider-feet', scene); riderFeet.parent = frame; riderFeet.position.set(0, 0.48, -0.1);
  const cameraTarget = new TransformNode('motorcycle:camera-target', scene); cameraTarget.parent = root; cameraTarget.position.y = 1.2;
  return { root, frame, wheels, riderSeat, riderHands, riderFeet, cameraTarget, handlebar,
    dispose: (): void => { root.dispose(false); for (const m of [paint, dark, metal]) m.dispose(); } };
}
