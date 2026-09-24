/**
 * 4x4 PROCEDURAL con primitivas de Babylon — PLACEHOLDER.
 *
 * Esto NO es el modelo final: es un bloque con cabina y cuatro ruedas armado con
 * `CreateBox`/`CreateCylinder` para poder conducir, medir la física y ver la
 * actitud sobre la pendiente. La versión definitiva es un GLB de Blender (con
 * manifiesto de ruedas y materiales), fuera del alcance de esta tarea.
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
import type { Mesh } from '@babylonjs/core/Meshes/mesh';
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
  const cabinMat = material(scene, 'vehicle:cabin', new Color3(0.08, 0.11, 0.14), 0.35);
  const trimMat = material(scene, 'vehicle:trim', new Color3(0.16, 0.16, 0.18));
  const wheelMat = material(scene, 'vehicle:wheel', new Color3(0.16, 0.16, 0.18), 0.08);

  const parts: Mesh[] = [];
  const wheelHubs: TransformNode[] = [];

  // Chasis y cabina (dimensiones aproximadas de un SWB tipo Jeep). El ancho del
  // chasis es MENOR que la trocha para que las ruedas queden a la vista.
  const chassisY = wheelRadius + 0.42;
  parts.push(box(scene, 'vehicle:chassis', bodyMat, 1.5, 0.5, 4.05, 0, chassisY, 0));
  parts.push(box(scene, 'vehicle:cabin', cabinMat, 1.38, 0.62, 1.9, 0, chassisY + 0.55, -0.3));
  parts.push(box(scene, 'vehicle:hood', bodyMat, 1.44, 0.16, 1.2, 0, chassisY + 0.33, 1.28));
  parts.push(box(scene, 'vehicle:roof-rack', trimMat, 1.2, 0.1, 1.5, 0, chassisY + 0.9, -0.3));
  parts.push(box(scene, 'vehicle:bumper-front', trimMat, 1.62, 0.2, 0.26, 0, wheelRadius + 0.1, 2.1));
  parts.push(box(scene, 'vehicle:bumper-rear', trimMat, 1.62, 0.2, 0.26, 0, wheelRadius + 0.1, -2.1));

  for (const part of parts) {
    part.parent = root;
  }

  const offsets: readonly (readonly [number, number])[] = [
    [-layout.halfTrack, layout.front],
    [layout.halfTrack, layout.front],
    [-layout.halfTrack, -layout.rear],
    [layout.halfTrack, -layout.rear],
  ];

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
    },
  };
}
