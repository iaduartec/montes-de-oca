import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import type { Scene } from '@babylonjs/core/scene';
import type { MotorcycleDefinition } from './catalog';

/**
 * Two low-poly but realistic off-road motorcycles, built from segmented shapes
 * (faceted tanks, tubes, cylinders) instead of interchangeable bricks:
 *  - `trail` is a Honda CRF300L dual-sport: red/white, tall and slim, headlight
 *    mask and high front fender, long seat, visible engine, high side exhaust,
 *    spoked knobby wheels, fork and swingarm clearly exposed.
 *  - `enduro` is a KTM 450 SX-F motocross: orange plastics, front number plate
 *    with no lights, beak-like fender, tall narrow seat, angular tank shrouds,
 *    exposed engine, exhaust and chain; no mirrors or luggage.
 * Frame, rider anchors and independently supported front/rear wheels keep the
 * existing physics contract; every owned resource is released in `dispose()`.
 */
export function createMotorcycleModel(scene: Scene, definition: MotorcycleDefinition) {
  const { params, visual } = definition;
  const trail = visual === 'trail';
  const root = new TransformNode(`motorcycle:${visual}`, scene);
  const frame = new TransformNode('motorcycle:frame', scene); frame.parent = root;

  const owned: StandardMaterial[] = [];
  const material = (name: string, color: string): StandardMaterial => {
    const m = new StandardMaterial(`motorcycle:${name}`, scene);
    m.diffuseColor = Color3.FromHexString(color);
    m.specularColor.set(0.12, 0.12, 0.12);
    owned.push(m);
    return m;
  };
  const paint = material('paint', trail ? '#c1272d' : '#f26f21');
  const accent = material('accent', '#f2f4f7');
  const graphite = material('graphite', '#2b3138');
  const metal = material('metal', '#8a949c');
  const rubber = material('rubber', '#15181c');
  const vinyl = material('vinyl', '#1d2126');

  const box = (name: string, width: number, height: number, depth: number, x: number, y: number, z: number, mat = paint, parent: TransformNode = frame) => {
    const mesh = MeshBuilder.CreateBox(`motorcycle:${name}`, { width, height, depth }, scene);
    mesh.parent = parent; mesh.position.set(x, y, z); mesh.material = mat; return mesh;
  };
  const cylinder = (name: string, diameter: number, height: number, x: number, y: number, z: number, mat: StandardMaterial, tessellation = 10, parent: TransformNode = frame) => {
    const mesh = MeshBuilder.CreateCylinder(`motorcycle:${name}`, { diameter, height, tessellation }, scene);
    mesh.parent = parent; mesh.position.set(x, y, z); mesh.material = mat; return mesh;
  };

  const front = params.wheelBase / 2;
  const rear = -params.wheelBase / 2;
  const radius = params.wheelRadius;

  // Faceted fuel tank with angular side shrouds (no plain brick).
  const tank = MeshBuilder.CreateCylinder(`motorcycle:tank-body-${visual}`, {
    diameterTop: trail ? 0.3 : 0.34, diameterBottom: trail ? 0.38 : 0.3,
    height: trail ? 0.54 : 0.46, tessellation: 6,
  }, scene);
  tank.parent = frame; tank.rotation.x = Math.PI / 2;
  tank.scaling.set(trail ? 0.92 : 0.82, 1, trail ? 0.68 : 0.78);
  tank.position.set(0, trail ? 0.88 : 0.87, 0.1); tank.material = paint;
  cylinder('tank-cap', 0.07, 0.03, 0, trail ? 1.0 : 0.99, 0.16, graphite, 8);
  for (const side of [-1, 1]) {
    const shroud = box(`shroud-${side < 0 ? 'left' : 'right'}`, 0.035, trail ? 0.24 : 0.22, trail ? 0.36 : 0.32,
      side * (trail ? 0.19 : 0.17), 0.84, 0.16);
    shroud.rotation.y = -side * 0.28;
    shroud.rotation.z = -side * 0.12;
  }

  // Seat, visible engine and high side exhaust.
  const seat = box('seat', trail ? 0.28 : 0.2, 0.07, trail ? 0.62 : 0.6, 0, 0.94, -0.28, vinyl);
  seat.rotation.x = trail ? 0.04 : 0.08;
  box('engine', 0.3, 0.3, 0.36, 0, 0.48, -0.02, graphite);
  const head = cylinder('engine-head', 0.24, 0.16, 0, 0.68, 0.05, metal, 8);
  head.rotation.x = trail ? -0.2 : -0.3;
  for (const fin of [0, 1, 2]) {
    const finMesh = cylinder(`engine-fin-${fin}`, trail ? 0.3 : 0.28, 0.012, 0, 0.6 + fin * 0.05, 0.03, graphite, 8);
    finMesh.rotation.x = head.rotation.x;
  }
  box('skid-plate', 0.34, 0.03, 0.4, 0, 0.31, -0.02, metal);
  const header = MeshBuilder.CreateTube('motorcycle:exhaust-header', {
    path: [new Vector3(0.06, 0.6, 0.14), new Vector3(0.12, 0.5, 0.02), new Vector3(0.19, 0.49, -0.16), new Vector3(0.21, 0.62, -0.34)],
    radius: 0.035, tessellation: 8,
  }, scene);
  header.parent = frame; header.material = metal;
  const muffler = cylinder('exhaust-muffler', trail ? 0.09 : 0.11, trail ? 0.44 : 0.4, 0.2, 0.72, -0.52, metal, 10);
  muffler.rotation.x = Math.PI / 2 - 0.22;

  // Swingarm, chain and sprockets exposed towards the rear axle.
  const swingarm = box('swingarm', trail ? 0.17 : 0.16, 0.08, 0.62, 0, radius + 0.01, rear / 2 - 0.05, metal);
  swingarm.rotation.x = -0.03;
  box('chain', 0.02, 0.05, 0.8, -0.14, 0.37, -0.33, graphite);
  const sprocketFront = cylinder('sprocket-front', 0.1, 0.03, -0.14, 0.4, 0.06, metal, 10);
  sprocketFront.rotation.z = Math.PI / 2;
  const sprocketRear = cylinder('sprocket-rear', trail ? 0.16 : 0.17, 0.03, -0.14, radius, rear, metal, 12);
  sprocketRear.rotation.z = Math.PI / 2;

  // Fork legs, triple clamp and steering handlebar.
  for (const side of [-1, 1]) {
    const leg = cylinder(`fork-${side < 0 ? 'left' : 'right'}`, trail ? 0.06 : 0.064, trail ? 0.68 : 0.64,
      side * 0.115, radius + 0.32, front - 0.02, metal, 10);
    leg.rotation.x = -0.12;
  }
  const triple = box('triple-clamp', 0.3, 0.07, 0.1, 0, trail ? 0.98 : 0.96, front - 0.06, metal);
  triple.rotation.x = -0.12;
  const handlebar = new TransformNode('motorcycle:handlebar', scene);
  handlebar.parent = frame; handlebar.position.set(0, 1.08, 0.5);
  const bar = cylinder('handlebar-bar', 0.03, definition.bodySize.widthM * 0.86, 0, 0, 0, graphite, 8, handlebar);
  bar.rotation.z = Math.PI / 2;
  for (const side of [-1, 1]) {
    const grip = cylinder(`grip-${side < 0 ? 'left' : 'right'}`, 0.045, 0.1, side * (definition.bodySize.widthM * 0.86 / 2 - 0.03), 0, 0, rubber, 8, handlebar);
    grip.rotation.z = Math.PI / 2;
  }
  for (const side of [-1, 1]) box(`footpeg-${side < 0 ? 'left' : 'right'}`, 0.16, 0.03, 0.08, side * 0.2, 0.42, -0.06, metal);

  // Fenders and lighting identity: Honda headlight/high fender, KTM beak/plate.
  const frontFender = box('front-fender', trail ? 0.24 : 0.22, 0.03, trail ? 0.6 : 0.72, 0, trail ? 0.8 : 0.74, trail ? 0.75 : 0.85);
  frontFender.rotation.x = trail ? -0.12 : -0.18;
  const rearFender = box('rear-fender', trail ? 0.2 : 0.18, 0.03, trail ? 0.52 : 0.46, 0, 0.86, -0.6);
  rearFender.rotation.x = 0.18;
  if (trail) {
    const mask = box('headlight-mask', 0.24, 0.22, 0.06, 0, 1.08, 0.72, accent);
    mask.rotation.x = -0.15;
    const lens = cylinder('headlight-lens', 0.14, 0.05, 0, 1.04, 0.76, accent, 10);
    lens.rotation.x = Math.PI / 2;
    box('taillight', 0.1, 0.06, 0.05, 0, 0.84, -0.86);
  } else {
    const plate = box('number-plate', 0.24, 0.2, 0.04, 0, 0.98, 0.76, accent);
    plate.rotation.x = -0.15;
  }

  // Independently supported front/rear spoked knobby wheels.
  const wheels = [1, -1].map(sign => {
    const name = sign === 1 ? 'front' : 'rear';
    const hub = new TransformNode(`motorcycle:wheel-${name}`, scene); hub.parent = root;
    hub.position.z = sign * params.wheelBase / 2;
    const spin = new TransformNode(`motorcycle:wheel-${name}-spin`, scene); spin.parent = hub;
    const tire = MeshBuilder.CreateCylinder('motorcycle:tire', { diameter: radius * 2, height: 0.16, tessellation: 24 }, scene);
    tire.parent = spin; tire.rotation.z = Math.PI / 2; tire.material = rubber;
    const rim = MeshBuilder.CreateCylinder('motorcycle:rim', { diameter: radius * 1.25, height: 0.14, tessellation: 20 }, scene);
    rim.parent = spin; rim.rotation.z = Math.PI / 2; rim.material = metal;
    const hubMesh = MeshBuilder.CreateCylinder('motorcycle:wheel-hub', { diameter: 0.11, height: 0.18, tessellation: 10 }, scene);
    hubMesh.parent = spin; hubMesh.rotation.z = Math.PI / 2; hubMesh.material = metal;
    for (let i = 0; i < 8; i++) {
      const spoke = MeshBuilder.CreateBox(`motorcycle:spoke-${i}`, { width: 0.02, height: radius * 1.16, depth: 0.02 }, scene);
      spoke.parent = spin; spoke.material = metal; spoke.rotation.x = i * Math.PI / 8;
    }
    for (let i = 0; i < 12; i++) {
      const angle = i * Math.PI / 6;
      const knob = MeshBuilder.CreateBox(`motorcycle:knob-${i}`, { width: 0.055, height: 0.028, depth: 0.055 }, scene);
      knob.parent = spin; knob.material = rubber;
      knob.position.set(0, (radius + 0.012) * Math.cos(angle), (radius + 0.012) * Math.sin(angle));
      knob.rotation.x = angle + Math.PI / 2;
    }
    return { hub, spin };
  });

  const riderSeat = new TransformNode('motorcycle:rider-seat', scene); riderSeat.parent = frame; riderSeat.position.set(0, 0.98, -0.23);
  const riderHands = new TransformNode('motorcycle:rider-hands', scene); riderHands.parent = frame; riderHands.position.set(0, 1.08, 0.47);
  const riderFeet = new TransformNode('motorcycle:rider-feet', scene); riderFeet.parent = frame; riderFeet.position.set(0, 0.48, -0.1);
  const cameraTarget = new TransformNode('motorcycle:camera-target', scene); cameraTarget.parent = root; cameraTarget.position.y = 1.2;
  return { root, frame, wheels, riderSeat, riderHands, riderFeet, cameraTarget, handlebar,
    dispose: (): void => { root.dispose(false); for (const m of owned) m.dispose(); } };
}
