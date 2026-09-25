/**
 * 4x4 procedural ligero con primitivas de Babylon. La carrocería, los cristales
 * y el equipo exterior son visuales; la física usa la disposición de ruedas.
 *
 * Jerarquía:
 *   root (posición + yaw + pitch + roll del vehículo)
 *     ├─ chasis / cabina / detalles
 *     └─ hub rueda ×4 (rotation = [spin, steer, 0])  ← el giro visual manda acá
 */

import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import { CreateBox } from '@babylonjs/core/Meshes/Builders/boxBuilder';
import { CreateCylinder } from '@babylonjs/core/Meshes/Builders/cylinderBuilder';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import type { Scene } from '@babylonjs/core/scene';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import type { WheelLayout } from './attitude';

export interface VehicleModel {
  readonly root: TransformNode;
  /** Ruedas en orden [FL, FR, RL, RR]. El índice 0 y 1 son directrices. */
  readonly wheels: readonly TransformNode[];
  /** Aplica el giro de rueda (rad) y el ángulo de dirección (rad). */
  setWheelPose(spin: number, steer: number): void;
  dispose(): void;
}

function material(scene: Scene, name: string, color: Color3, specular = 0.1): StandardMaterial {
  const mat = new StandardMaterial(name, scene);
  mat.diffuseColor = color;
  mat.specularColor = new Color3(specular, specular, specular);
  mat.ambientColor = new Color3(0.18, 0.18, 0.18);
  return mat;
}

function box(scene: Scene, name: string, mat: StandardMaterial, width: number, height: number, depth: number, x: number, y: number, z: number): Mesh {
  const mesh = CreateBox(name, { width, height, depth }, scene);
  mesh.material = mat;
  mesh.position.set(x, y, z);
  mesh.isPickable = false;
  mesh.receiveShadows = true;
  return mesh;
}

export function createVehicleModel(scene: Scene, layout: WheelLayout, wheelRadius: number, wheelWidth = 0.32): VehicleModel {
  const root = new TransformNode('vehicle:root', scene);

  const bodyMat = material(scene, 'vehicle:body', new Color3(0.83, 0.36, 0.1));
  const cabinMat = material(scene, 'vehicle:glass', new Color3(0.12, 0.23, 0.27), 0.35);
  const trimMat = material(scene, 'vehicle:trim', new Color3(0.16, 0.16, 0.18));
  const wheelMat = material(scene, 'vehicle:wheel', new Color3(0.16, 0.16, 0.18), 0.08);
  const lampMat = material(scene, 'vehicle:lamp', new Color3(0.86, 0.78, 0.57), 0.25);

  const parts: Mesh[] = [];
  const wheelHubs: TransformNode[] = [];

  // Chasis y cabina (dimensiones aproximadas de un SWB tipo Jeep). El ancho del
  // chasis es MENOR que la trocha para que las ruedas queden a la vista.
  const chassisY = wheelRadius + 0.42;
  parts.push(box(scene, 'vehicle:chassis', bodyMat, 1.5, 0.5, 4.05, 0, chassisY, 0));
  parts.push(box(scene, 'vehicle:cabin', bodyMat, 1.38, 0.62, 1.9, 0, chassisY + 0.55, -0.3));
  parts.push(box(scene, 'vehicle:hood', bodyMat, 1.44, 0.16, 1.2, 0, chassisY + 0.33, 1.28));
  // The sloping glass and painted surround give the cabin a more distinct profile.
  const windshield = box(scene, 'vehicle:windshield', cabinMat, 1.08, 0.4, 0.035, 0, chassisY + 0.59, 0.67);
  windshield.rotation.x = -0.18;
  parts.push(windshield);
  for (const side of [-1, 1] as const) {
    const x = side * 0.71;
    // Dos lunas laterales con un pilar visible dan escala y lectura de cabina.
    parts.push(box(scene, `vehicle:side-glass-front-${side}`, cabinMat, 0.035, 0.34, 0.49, x, chassisY + 0.59, 0.12));
    parts.push(box(scene, `vehicle:side-glass-rear-${side}`, cabinMat, 0.035, 0.34, 0.49, x, chassisY + 0.59, -0.72));
    parts.push(box(scene, `vehicle:window-pillar-${side}`, trimMat, 0.045, 0.4, 0.07, side * 0.724, chassisY + 0.59, -0.3));
    // Escalón, manilla y espejo exterior propios de un 4x4 de trabajo.
    parts.push(box(scene, `vehicle:side-step-${side}`, trimMat, 0.2, 0.1, 1.35, side * 0.83, wheelRadius + 0.22, -0.25));
    parts.push(box(scene, `vehicle:door-handle-${side}`, trimMat, 0.035, 0.055, 0.16, side * 0.755, chassisY + 0.28, -0.25));
    parts.push(box(scene, `vehicle:mirror-arm-${side}`, trimMat, 0.035, 0.16, 0.055, side * 0.77, chassisY + 0.7, 0.53));
    parts.push(box(scene, `vehicle:mirror-${side}`, bodyMat, 0.14, 0.12, 0.2, side * 0.85, chassisY + 0.76, 0.53));
    // Baca abierta: deja ver la cubierta y rompe el perfil de caja maciza.
    parts.push(box(scene, `vehicle:rack-rail-${side}`, trimMat, 0.07, 0.075, 1.48, side * 0.48, chassisY + 0.91, -0.3));
    // Juntas verticales muy finas separan las puertas sin dibujar textura.
    parts.push(box(scene, `vehicle:door-seam-front-${side}`, trimMat, 0.025, 0.52, 0.025, side * 0.746, chassisY + 0.28, 0.5));
    parts.push(box(scene, `vehicle:door-seam-rear-${side}`, trimMat, 0.025, 0.52, 0.025, side * 0.746, chassisY + 0.28, -0.94));
  }
  for (const [bar, z] of [-0.88, -0.3, 0.28].entries()) {
    parts.push(box(scene, `vehicle:rack-crossbar-${bar}`, trimMat, 0.98, 0.055, 0.07, 0, chassisY + 0.91, z));
  }
  parts.push(box(scene, 'vehicle:rear-glass', cabinMat, 0.94, 0.34, 0.035, 0, chassisY + 0.59, -1.27));
  parts.push(box(scene, 'vehicle:bumper-front', trimMat, 1.62, 0.2, 0.26, 0, wheelRadius + 0.1, 2.1));
  parts.push(box(scene, 'vehicle:bumper-rear', trimMat, 1.62, 0.2, 0.26, 0, wheelRadius + 0.1, -2.1));
  parts.push(box(scene, 'vehicle:grille', trimMat, 0.82, 0.26, 0.035, 0, chassisY + 0.08, 2.044));
  parts.push(box(scene, 'vehicle:headlamp-left', lampMat, 0.25, 0.2, 0.04, -0.57, chassisY + 0.1, 2.05));
  parts.push(box(scene, 'vehicle:headlamp-right', lampMat, 0.25, 0.2, 0.04, 0.57, chassisY + 0.1, 2.05));

  const spare = CreateCylinder('vehicle:spare-wheel', { height: 0.2, diameter: wheelRadius * 1.65, tessellation: 12 }, scene);
  spare.material = wheelMat;
  spare.rotation.x = Math.PI / 2;
  spare.position.set(0.38, chassisY + 0.18, -2.16);
  spare.isPickable = false;
  spare.receiveShadows = true;
  parts.push(spare);

  // Agrupar las piezas estáticas por material: los nuevos rasgos no añaden
  // llamadas de dibujo; las cuatro ruedas siguen separadas para girar.
  const staticByMaterial = new Map<StandardMaterial, Mesh[]>();
  for (const part of parts) {
    const group = staticByMaterial.get(part.material as StandardMaterial) ?? [];
    group.push(part);
    staticByMaterial.set(part.material as StandardMaterial, group);
  }
  let staticGroup = 0;
  for (const group of staticByMaterial.values()) {
    const merged = group.length === 1 ? group[0]! : Mesh.MergeMeshes(group, true, true, undefined, false, false);
    if (!merged) throw new Error('No se pudieron agrupar los detalles estáticos del vehículo');
    merged.name = `vehicle:static-${staticGroup++}`;
    merged.parent = root;
    merged.isPickable = false;
    merged.receiveShadows = true;
  }

  const offsets: readonly (readonly [number, number])[] = [
    [-layout.halfTrack, layout.front],
    [layout.halfTrack, layout.front],
    [-layout.halfTrack, -layout.rear],
    [layout.halfTrack, -layout.rear],
  ];

  // One merged body-colour mesh covers the upper edge of the four tyres. The
  // wheel hubs remain free to steer and spin without extra per-frame work.
  const wingPieces: Mesh[] = [];
  for (let i = 0; i < offsets.length; i++) {
    const [x, z] = offsets[i]!;
    wingPieces.push(box(scene, `vehicle:wing-${i}`, bodyMat, 0.4, 0.12, wheelRadius * 2.15, x, wheelRadius * 2 + 0.035, z));
  }
  const wings = Mesh.MergeMeshes(wingPieces, true);
  if (!wings) throw new Error('No se pudieron crear las aletas del vehículo');
  wings.name = 'vehicle:wings';
  wings.parent = root;
  wings.isPickable = false;
  wings.receiveShadows = true;

  for (let i = 0; i < offsets.length; i++) {
    const [x, z] = offsets[i]!;
    const hub = new TransformNode(`vehicle:wheel-hub-${i}`, scene);
    hub.parent = root;
    hub.position.set(x, wheelRadius, z);

    // El cilindro nace con eje Y; rotarlo 90° en Z lo deja con eje X (el eje de
    // giro). El spin se aplica en el hub (rotation.x) y la dirección en Y.
    const tyre = CreateCylinder(`vehicle:wheel-${i}`, { height: wheelWidth, diameter: wheelRadius * 2, tessellation: 18 }, scene);
    tyre.material = wheelMat;
    tyre.rotation.z = Math.PI / 2;
    tyre.parent = hub;
    tyre.isPickable = false;
    tyre.receiveShadows = true;

    wheelHubs.push(hub);
  }

  return {
    root,
    wheels: wheelHubs,
    setWheelPose: (spin: number, steer: number) => {
      for (let i = 0; i < wheelHubs.length; i++) {
        const hub = wheelHubs[i]!;
        const steered = i < 2 ? steer : 0; // sólo las delanteras giran
        hub.rotation.set(spin, steered, 0);
      }
    },
    dispose: () => {
      root.dispose(false, true);
      bodyMat.dispose();
      cabinMat.dispose();
      trimMat.dispose();
      wheelMat.dispose();
      lampMat.dispose();
    },
  };
}
