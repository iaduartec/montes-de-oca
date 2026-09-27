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
import type { VehicleBodySize } from './types';

export type FourWheelVisual = 'estandar' | 'patrulla' | 'carga' | 'explorador' | 'turismo' | 'rally';

export interface VehicleModel {
  readonly root: TransformNode;
  /** Ruedas en orden [FL, FR, RL, RR]. El índice 0 y 1 son directrices. */
  readonly wheels: readonly TransformNode[];
  /** Aplica el giro de rueda (rad) y el ángulo de dirección (rad). */
  setWheelPose(spin: number, steer: number): void;
  setAppearance(id: FourWheelVisual): void;
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

function createCatalogBody(scene: Scene, layout: WheelLayout, wheelRadius: number, visual: FourWheelVisual, size: VehicleBodySize): VehicleModel {
  const root = new TransformNode('vehicle:root', scene);
  const palettes: Record<string, Color3> = {
    explorador: new Color3(0.28, 0.43, 0.31),
    turismo: new Color3(0.33, 0.42, 0.54),
    rally: new Color3(0.72, 0.3, 0.2),
  };
  const bodyMat = material(scene, 'vehicle:body', palettes[visual] ?? new Color3(0.4, 0.43, 0.32));
  const glassMat = material(scene, 'vehicle:glass', new Color3(0.1, 0.17, 0.22), 0.3);
  const trimMat = material(scene, 'vehicle:trim', new Color3(0.12, 0.12, 0.13));
  const wheelMat = material(scene, 'vehicle:wheel', new Color3(0.09, 0.09, 0.1));
  const mats = [bodyMat, glassMat, trimMat, wheelMat];
  const parts: Mesh[] = [];
  const width = size.widthM * 0.78;
  const length = size.lengthM;
  const chassisY = wheelRadius + (visual === 'explorador' ? 0.43 : 0.29);
  parts.push(taperedBox(scene, `vehicle:${visual}-chassis`, bodyMat, width, length, width * 0.94, length * 0.97, 0.42, 0, chassisY, 0));
  const cabinLength = visual === 'explorador' ? length * 0.48 : length * 0.45;
  const cabinHeight = Math.max(0.35, size.heightM - chassisY - 0.3);
  parts.push(taperedBox(scene, `vehicle:${visual}-cabin`, bodyMat, width * 0.86, cabinLength,
    width * (visual === 'explorador' ? 0.8 : 0.65), cabinLength * 0.82, cabinHeight,
    0, chassisY + 0.21 + cabinHeight / 2, visual === 'explorador' ? -0.22 : -0.15));
  parts.push(box(scene, `vehicle:${visual}-windshield`, glassMat, width * 0.63, cabinHeight * 0.43, 0.04,
    0, chassisY + 0.25 + cabinHeight * 0.56, cabinLength * 0.4 - 0.15));
  for (const side of [-1, 1] as const) {
    parts.push(box(scene, `vehicle:${visual}-side-glass-${side}`, glassMat, 0.035, cabinHeight * 0.35,
      cabinLength * 0.48, side * width * 0.39, chassisY + 0.25 + cabinHeight * 0.58, -0.18));
  }
  if (visual === 'explorador') {
    parts.push(box(scene, 'vehicle:explorador-roof-rack', trimMat, width * 0.68, 0.06, cabinLength * 0.68,
      0, chassisY + cabinHeight + 0.45, -0.22));
    parts.push(box(scene, 'vehicle:explorador-front-guard', trimMat, width * 0.85, 0.22, 0.13,
      0, chassisY, length / 2 + 0.04));
  } else if (visual === 'turismo') {
    parts.push(taperedBox(scene, 'vehicle:turismo-trunk', bodyMat, width * 0.94, length * 0.24,
      width * 0.88, length * 0.22, 0.16, 0, chassisY + 0.28, -length * 0.37));
  } else {
    parts.push(box(scene, 'vehicle:rally-spoiler', trimMat, width * 0.75, 0.08, 0.26,
      0, chassisY + 0.65, -length * 0.47));
    parts.push(box(scene, 'vehicle:rally-roof-scoop', trimMat, 0.43, 0.13, 0.5,
      0, chassisY + cabinHeight + 0.42, -0.17));
  }
  for (const side of [-1, 1] as const) {
    parts.push(box(scene, `vehicle:${visual}-headlight-${side}`, glassMat, 0.25, 0.12, 0.04,
      side * width * 0.32, chassisY + 0.13, length / 2));
  }
  const byMaterial = new Map<StandardMaterial, Mesh[]>();
  for (const part of parts) {
    const group = byMaterial.get(part.material as StandardMaterial) ?? [];
    group.push(part);
    byMaterial.set(part.material as StandardMaterial, group);
  }
  let groupIndex = 0;
  for (const group of byMaterial.values()) {
    const merged = group.length === 1 ? group[0]! : Mesh.MergeMeshes(group, true, true, undefined, false, false);
    if (!merged) throw new Error(`Could not merge ${visual} body`);
    merged.name = groupIndex++ === 0 ? `vehicle:body-${visual}` : `vehicle:detail-${visual}-${groupIndex}`;
    merged.parent = root;
  }
  const offsets: readonly (readonly [number, number])[] = [
    [-layout.halfTrack, layout.front], [layout.halfTrack, layout.front],
    [-layout.halfTrack, -layout.rear], [layout.halfTrack, -layout.rear],
  ];
  const wheels = offsets.map(([x, z], i) => {
    const hub = new TransformNode(`vehicle:wheel-hub-${i}`, scene);
    hub.parent = root;
    hub.position.set(x, wheelRadius, z);
    const tyre = CreateCylinder(`vehicle:wheel-${i}`, { height: 0.3, diameter: 2 * wheelRadius, tessellation: 16 }, scene);
    tyre.material = wheelMat;
    tyre.rotation.z = Math.PI / 2;
    tyre.parent = hub;
    return hub;
  });
  return {
    root, wheels,
    setWheelPose: (spin, steer) => wheels.forEach((hub, i) => hub.rotation.set(spin, i < 2 ? steer : 0, 0)),
    setAppearance: () => {},
    dispose: () => { root.dispose(false, true); mats.forEach((mat) => mat.dispose()); },
  };
}

export function createVehicleModel(scene: Scene, layout: WheelLayout, wheelRadius: number, wheelWidth = 0.32,
  visual?: FourWheelVisual, bodySize?: VehicleBodySize): VehicleModel {
  if (visual && bodySize && (visual === 'explorador' || visual === 'turismo' || visual === 'rally')) {
    return createCatalogBody(scene, layout, wheelRadius, visual, bodySize);
  }
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

  // Each selectable vehicle has its own silhouette. Patrol is a long-roof
  // wagon with a rear cabin and service lightbar; cargo is an open-bed pickup.
  // The kits are merged and hidden until selected, without changing physics.
  const patrolPieces = [
    box(scene, 'vehicle:patrol-lightbar', lampMat, 1.06, 0.13, 0.24, 0, chassisY + 1.08, -0.3),
    box(scene, 'vehicle:patrol-wagon-roof', bodyMat, 1.3, 0.12, 1.28, 0, chassisY + 0.91, -1.52),
    box(scene, 'vehicle:patrol-rear-door', bodyMat, 1.18, 0.48, 0.09, 0, chassisY + 0.37, -2.12),
    box(scene, 'vehicle:patrol-rear-glass', cabinMat, 0.88, 0.28, 0.035, 0, chassisY + 0.65, -2.18),
  ];
  for (const side of [-1, 1] as const) {
    patrolPieces.push(
      box(scene, `vehicle:patrol-side-body-${side}`, bodyMat, 0.06, 0.4, 0.92, side * 0.65, chassisY + 0.27, -1.59),
      box(scene, `vehicle:patrol-side-glass-${side}`, cabinMat, 0.035, 0.28, 0.74, side * 0.685, chassisY + 0.64, -1.59),
    );
  }
  const patrolKit = Mesh.MergeMeshes(patrolPieces, true, true, undefined, false, false);
  if (!patrolKit) throw new Error('No se pudo crear la carrocería de patrulla');
  patrolKit.name = 'vehicle:variant-patrulla';
  patrolKit.parent = root;
  patrolKit.setEnabled(false);
  patrolKit.isPickable = false;
  patrolKit.receiveShadows = false;

  const cargoPieces = [
    box(scene, 'vehicle:cargo-bed', trimMat, 1.48, 0.2, 1.72, 0, chassisY + 0.42, -1.28),
    box(scene, 'vehicle:cargo-side-left', trimMat, 0.11, 0.48, 1.72, -0.69, chassisY + 0.73, -1.28),
    box(scene, 'vehicle:cargo-side-right', trimMat, 0.11, 0.48, 1.72, 0.69, chassisY + 0.73, -1.28),
    box(scene, 'vehicle:cargo-tailgate', trimMat, 1.36, 0.46, 0.12, 0, chassisY + 0.72, -2.08),
    box(scene, 'vehicle:cargo-load', bodyMat, 0.92, 0.35, 0.74, 0, chassisY + 0.84, -1.28),
  ];
  const cargoKit = Mesh.MergeMeshes(cargoPieces, true, true, undefined, false, false);
  if (!cargoKit) throw new Error('No se pudo crear la variante de carga');
  cargoKit.name = 'vehicle:variant-carga';
  cargoKit.parent = root;
  cargoKit.setEnabled(false);
  cargoKit.isPickable = false;
  cargoKit.receiveShadows = false;

  if (visual && bodySize) {
    root.getChildMeshes().find((mesh) => mesh.name === 'vehicle:static-0')!.name = `vehicle:body-${visual}`;
    if (visual !== 'patrulla') patrolKit.dispose();
    if (visual !== 'carga') cargoKit.dispose();
    if (visual === 'patrulla') patrolKit.setEnabled(true);
    if (visual === 'carga') cargoKit.setEnabled(true);
    bodyMat.diffuseColor = visual === 'patrulla'
      ? new Color3(0.69, 0.7, 0.64)
      : visual === 'carga' ? new Color3(0.48, 0.38, 0.25) : new Color3(0.4, 0.43, 0.32);
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
    setAppearance: (id) => {
      patrolKit.setEnabled(id === 'patrulla');
      cargoKit.setEnabled(id === 'carga');
      bodyMat.diffuseColor = id === 'patrulla'
        ? new Color3(0.69, 0.7, 0.64)
        : id === 'carga'
          ? new Color3(0.48, 0.38, 0.25)
          : new Color3(0.4, 0.43, 0.32);
    },
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
