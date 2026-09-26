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
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData';
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
  // The coarse sun shadow map created triangular acne across the faceted body.
  // The vehicle still casts its contact shadow onto terrain and nearby objects.
  mesh.receiveShadows = false;
  return mesh;
}

/**
 * Caja con la cara superior reducida (frustum). Los cuatro laterales quedan
 * inclinados y aportan el chaflán low-poly del capó, la cabina y los pasos de
 * rueda. Se construye desde CreateBox moviendo sólo los vértices superiores,
 * así la topología —y el coste— siguen siendo los de una caja: 12 triángulos.
 */
function taperedBox(
  scene: Scene,
  name: string,
  mat: StandardMaterial,
  bottomWidth: number,
  bottomDepth: number,
  topWidth: number,
  topDepth: number,
  height: number,
  x: number,
  y: number,
  z: number,
): Mesh {
  const mesh = CreateBox(name, { width: bottomWidth, height, depth: bottomDepth }, scene);
  const positions = mesh.getVerticesData('position');
  const indices = mesh.getIndices();
  if (positions && indices) {
    const sx = topWidth / bottomWidth;
    const sz = topDepth / bottomDepth;
    for (let i = 0; i < positions.length; i += 3) {
      if (positions[i + 1]! > 0) {
        positions[i] = positions[i]! * sx;
        positions[i + 2] = positions[i + 2]! * sz;
      }
    }
    mesh.updateVerticesData('position', positions, true);
    const normals: number[] = [];
    VertexData.ComputeNormals(positions, indices, normals);
    mesh.updateVerticesData('normal', normals);
  }
  mesh.material = mat;
  mesh.position.set(x, y, z);
  mesh.isPickable = false;
  mesh.receiveShadows = false;
  return mesh;
}

export function createVehicleModel(scene: Scene, layout: WheelLayout, wheelRadius: number, wheelWidth = 0.32): VehicleModel {
  const root = new TransformNode('vehicle:root', scene);

  // Paleta de vehículo de trabajo rural: verde aceituna apagado, negro mate y
  // cristales oscuros. Se reutilizan los materiales existentes para no sumar
  // llamadas de dibujo.
  const bodyMat = material(scene, 'vehicle:body', new Color3(0.4, 0.43, 0.32), 0.06);
  const cabinMat = material(scene, 'vehicle:glass', new Color3(0.11, 0.19, 0.2), 0.32);
  const trimMat = material(scene, 'vehicle:trim', new Color3(0.14, 0.14, 0.15), 0.06);
  const wheelMat = material(scene, 'vehicle:wheel', new Color3(0.13, 0.13, 0.14), 0.06);
  const lampMat = material(scene, 'vehicle:lamp', new Color3(0.85, 0.77, 0.55), 0.22);

  const parts: Mesh[] = [];
  const wheelHubs: TransformNode[] = [];

  // Chasis y cabina (dimensiones aproximadas de un SWB tipo Jeep). El ancho del
  // chasis es MENOR que la trocha para que las ruedas queden a la vista.
  const chassisY = wheelRadius + 0.42;
  // Bajos estrechados: el chaflán del estribo rompe la lectura de ladrillo.
  parts.push(taperedBox(scene, 'vehicle:chassis', bodyMat, 1.42, 4.0, 1.5, 4.05, 0.5, 0, chassisY, 0));
  // Cabina con las paredes caídas hacia el techo: facetas laterales limpias.
  parts.push(taperedBox(scene, 'vehicle:cabin', bodyMat, 1.38, 1.9, 1.3, 1.9, 0.62, 0, chassisY + 0.55, -0.3));
  // Capó con nariz inclinada y hombros caídos hacia el frente.
  parts.push(taperedBox(scene, 'vehicle:hood', bodyMat, 1.46, 1.26, 1.34, 1.1, 0.2, 0, chassisY + 0.31, 1.28));
  // Bulto central del capó: detalle legible de 4x4 de trabajo.
  parts.push(taperedBox(scene, 'vehicle:hood-bulge', bodyMat, 0.54, 0.94, 0.42, 0.74, 0.06, 0, chassisY + 0.42, 1.2));
  // Regleta negra en el borde del capó: separa la nariz del parabrisas.
  parts.push(box(scene, 'vehicle:hood-lip', trimMat, 1.32, 0.05, 0.07, 0, chassisY + 0.4, 1.85));

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
    // Moldura lateral continua: marca la línea de cintura y estiliza el costado.
    parts.push(box(scene, `vehicle:side-rub-${side}`, trimMat, 0.045, 0.09, 3.0, side * 0.735, chassisY + 0.16, -0.4));
    // Baca abierta: deja ver la cubierta y rompe el perfil de caja maciza.
    parts.push(box(scene, `vehicle:rack-rail-${side}`, trimMat, 0.07, 0.075, 1.48, side * 0.48, chassisY + 0.91, -0.3));
    // Juntas verticales muy finas separan las puertas sin dibujar textura.
    parts.push(box(scene, `vehicle:door-seam-front-${side}`, trimMat, 0.025, 0.52, 0.025, side * 0.746, chassisY + 0.28, 0.5));
    parts.push(box(scene, `vehicle:door-seam-rear-${side}`, trimMat, 0.025, 0.52, 0.025, side * 0.746, chassisY + 0.28, -0.94));
  }
  for (const [bar, z] of [-0.88, -0.3, 0.28].entries()) {
    parts.push(box(scene, `vehicle:rack-crossbar-${bar}`, trimMat, 0.98, 0.055, 0.07, 0, chassisY + 0.91, z));
  }
  // Faros de trabajo sobre la baca delantera: identidad de vehículo rural.
  parts.push(box(scene, 'vehicle:rack-lamp-left', lampMat, 0.14, 0.05, 0.09, -0.26, chassisY + 0.92, 0.28));
  parts.push(box(scene, 'vehicle:rack-lamp-right', lampMat, 0.14, 0.05, 0.09, 0.26, chassisY + 0.92, 0.28));

  parts.push(box(scene, 'vehicle:rear-glass', cabinMat, 0.94, 0.34, 0.035, 0, chassisY + 0.59, -1.27));
  parts.push(box(scene, 'vehicle:taillamp-left', lampMat, 0.14, 0.24, 0.05, -0.66, chassisY + 0.14, -2.03));
  parts.push(box(scene, 'vehicle:taillamp-right', lampMat, 0.14, 0.24, 0.05, 0.66, chassisY + 0.14, -2.03));
  parts.push(box(scene, 'vehicle:bumper-front', trimMat, 1.62, 0.2, 0.26, 0, wheelRadius + 0.1, 2.1));
  parts.push(box(scene, 'vehicle:bumper-rear', trimMat, 1.62, 0.2, 0.26, 0, wheelRadius + 0.1, -2.1));
  parts.push(box(scene, 'vehicle:grille', trimMat, 0.82, 0.26, 0.035, 0, chassisY + 0.08, 2.044));
  parts.push(box(scene, 'vehicle:headlamp-left', lampMat, 0.25, 0.2, 0.04, -0.57, chassisY + 0.1, 2.05));
  parts.push(box(scene, 'vehicle:headlamp-right', lampMat, 0.25, 0.2, 0.04, 0.57, chassisY + 0.1, 2.05));
  // Defensa de protección delantera (bull bar) montada sobre el paragolpes.
  parts.push(box(scene, 'vehicle:bullbar-post-left', trimMat, 0.07, 0.7, 0.07, -0.5, wheelRadius + 0.55, 2.19));
  parts.push(box(scene, 'vehicle:bullbar-post-right', trimMat, 0.07, 0.7, 0.07, 0.5, wheelRadius + 0.55, 2.19));
  parts.push(box(scene, 'vehicle:bullbar-bar-low', trimMat, 1.08, 0.07, 0.07, 0, wheelRadius + 0.3, 2.19));
  parts.push(box(scene, 'vehicle:bullbar-bar-high', trimMat, 1.08, 0.07, 0.07, 0, wheelRadius + 0.75, 2.19));

  for (const [axle, z] of [['front', layout.front - 0.45], ['rear', -(layout.rear + 0.45)]] as const) {
    for (const side of [-1, 1] as const) {
      // Guardabarros flexibles: detalle sobrio de vehículo de trabajo.
      parts.push(box(scene, `vehicle:mudflap-${axle}-${side}`, trimMat, 0.3, 0.24, 0.03, side * layout.halfTrack, wheelRadius - 0.08, z));
    }
  }

  const spare = CreateCylinder('vehicle:spare-wheel', { height: 0.2, diameter: wheelRadius * 1.65, tessellation: 12 }, scene);
  spare.material = wheelMat;
  spare.rotation.x = Math.PI / 2;
  spare.position.set(0.38, chassisY + 0.18, -2.16);
  spare.isPickable = false;
  spare.receiveShadows = false;
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
    merged.receiveShadows = false;
  }

  const offsets: readonly (readonly [number, number])[] = [
    [-layout.halfTrack, layout.front],
    [layout.halfTrack, layout.front],
    [-layout.halfTrack, -layout.rear],
    [layout.halfTrack, -layout.rear],
  ];

  // One merged body-colour mesh covers the upper edge of the four tyres. The
  // wheel hubs remain free to steer and spin without extra per-frame work.
  // Cada aleta se bisela hacia arriba para insinuar el paso de rueda.
  const wingPieces: Mesh[] = [];
  for (let i = 0; i < offsets.length; i++) {
    const [x, z] = offsets[i]!;
    wingPieces.push(taperedBox(scene, `vehicle:wing-${i}`, bodyMat, 0.42, wheelRadius * 2.15, 0.34, wheelRadius * 1.9, 0.16, x, wheelRadius * 2 + 0.06, z));
  }
  const wings = Mesh.MergeMeshes(wingPieces, true);
  if (!wings) throw new Error('No se pudieron crear las aletas del vehículo');
  wings.name = 'vehicle:wings';
  wings.parent = root;
  wings.isPickable = false;
  wings.receiveShadows = false;

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
    tyre.receiveShadows = false;

    // Tapa de buje de 8 lados (32 triángulos): un plato troncocónico que asoma en
    // la cara EXTERIOR de la llanta. Cuelga del hub, así que gira y dobla con la
    // rueda; reutiliza el material de la carrocería y suma una llamada de dibujo.
    const hubCap = CreateCylinder(`vehicle:hub-cap-${i}`, { height: 0.07, diameterTop: wheelRadius * 0.62, diameterBottom: wheelRadius * 1.15, tessellation: 8 }, scene);
    hubCap.material = bodyMat;
    hubCap.rotation.z = x > 0 ? -Math.PI / 2 : Math.PI / 2; // el plato apunta hacia afuera
    hubCap.position.x = Math.sign(x) * (wheelWidth / 2);
    hubCap.parent = hub;
    hubCap.isPickable = false;
    hubCap.receiveShadows = false;

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
