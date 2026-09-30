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
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial';
import { SceneLoader } from '@babylonjs/core/Loading/sceneLoader';
import '@babylonjs/loaders/glTF';
import type { Material } from '@babylonjs/core/Materials/material';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import type { Scene } from '@babylonjs/core/scene';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh';
import type { WheelLayout } from './attitude';
import type { VehicleBodySize } from './types';
import { publicUrl } from '../public-url';

export type FourWheelVisual = 'estandar' | 'patrulla' | 'carga' | 'explorador' | 'turismo' | 'rally';

export interface VehicleModel {
  readonly root: TransformNode;
  /** Ruedas en orden [FL, FR, RL, RR]. El índice 0 y 1 son directrices. */
  readonly wheels: readonly TransformNode[];
  /** Aplica el giro de rueda (rad) y el ángulo de dirección (rad). */
  setWheelPose(spin: number, steer: number): void;
  /** Enciende las luces rojas al frenar o usar el freno de mano. */
  setBrakeLights(active: boolean): void;
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

/** Pintura de carrocería: usa el IBL de la escena para reflejos suaves de cielo. */
function paintMaterial(scene: Scene, name: string, color: Color3): PBRMaterial {
  const mat = new PBRMaterial(name, scene);
  mat.albedoColor = color;
  // Pintura opaca de vehículo de campo: respuesta dieléctrica y reflejo amplio.
  mat.metallic = 0.12;
  mat.roughness = 0.38;
  mat.clearCoat.isEnabled = true;
  mat.clearCoat.intensity = 0.28;
  mat.clearCoat.roughness = 0.24;
  return mat;
}

/** Cristal tintado: capa de reflejo marcada, con una base oscura todavía opaca. */
function glassMaterial(scene: Scene, name: string, color: Color3): PBRMaterial {
  const mat = new PBRMaterial(name, scene);
  mat.albedoColor = color;
  mat.metallic = 0;
  mat.roughness = 0.2;
  mat.clearCoat.isEnabled = true;
  mat.clearCoat.intensity = 0.62;
  mat.clearCoat.roughness = 0.1;
  return mat;
}

function brakeLightMaterial(scene: Scene, name: string): PBRMaterial {
  const mat = new PBRMaterial(name, scene);
  mat.albedoColor = new Color3(0.42, 0.035, 0.025);
  mat.metallic = 0;
  mat.roughness = 0.42;
  mat.emissiveColor = Color3.Black();
  return mat;
}

function setBrakeLightEmission(mat: PBRMaterial, active: boolean): void {
  mat.emissiveColor = active ? new Color3(1, 0.012, 0.004) : Color3.Black();
  mat.emissiveIntensity = active ? 2.2 : 1;
}

function box(scene: Scene, name: string, mat: Material, width: number, height: number, depth: number, x: number, y: number, z: number): Mesh {
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
  mat: Material,
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

/**
 * Caja perfilada: taper superior (como taperedBox) + caída diferencial del
 * plano superior (wedge). frontDrop hunde el borde delantero y rearDrop el
 * trasero. Misma topología y coste que una caja (12 triángulos); rompe el
 * perfil de ladrillo en capó (morro bajo), cabina (corona de techo) y baúl
 * (cola caída).
 */
function slopedBox(
  scene: Scene,
  name: string,
  mat: Material,
  bottomWidth: number,
  bottomDepth: number,
  topWidth: number,
  topDepth: number,
  height: number,
  x: number,
  y: number,
  z: number,
  frontDrop = 0,
  rearDrop = 0,
): Mesh {
  const mesh = CreateBox(name, { width: bottomWidth, height, depth: bottomDepth }, scene);
  const positions = mesh.getVerticesData('position');
  const indices = mesh.getIndices();
  if (positions && indices) {
    const sx = topWidth / bottomWidth;
    const sz = topDepth / bottomDepth;
    const maxDrop = height * 0.85;
    const fDrop = Math.min(Math.max(frontDrop, 0), maxDrop);
    const rDrop = Math.min(Math.max(rearDrop, 0), maxDrop);
    for (let i = 0; i < positions.length; i += 3) {
      if (positions[i + 1]! > 0) {
        positions[i] = positions[i]! * sx;
        const lz = positions[i + 2]! * sz;
        positions[i + 2] = lz;
        positions[i + 1] = positions[i + 1]! - (lz > 0 ? fDrop : rDrop);
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

/**
 * Ancho visual atado al tamaño homologado y a la pisada: cubre el exterior
 * del neumático (`halfTrack + wheelWidth/2`) sin pasarse de `size + 8 cm`.
 * Así las ruedas no quedan por fuera de la carrocería (efecto kart del A4).
 */
function catalogBodyWidth(sizeWidthM: number, halfTrack: number, wheelWidth: number, factor: number): number {
  const fromSize = sizeWidthM * factor;
  const fromTrack = halfTrack * 2 + wheelWidth + 0.02;
  return Math.min(Math.max(fromSize, fromTrack), sizeWidthM + 0.08);
}

/**
 * Guardabarros de aspecto redondeado con una sola caja afilada por rueda:
 * tapa el borde exterior del neumático con 3 cm de luz y se solapa con el
 * lateral para no flotar. Se fusiona con su grupo de material (sin dibujos
 * extra) y deja la huella `arch-` para los asserts de geometría.
 */
function archCap(
  scene: Scene,
  kit: CatalogKit,
  mat: Material,
  name: string,
  x: number,
  z: number,
  wheelRadius: number,
  wheelWidth: number,
): void {
  const capH = 0.14;
  kit.parts.push(taperedBox(
    scene, name, mat,
    wheelWidth + 0.16, wheelRadius * 2.2 + 0.1,
    wheelWidth + 0.1, wheelRadius * 2.0 + 0.08,
    capH, x, wheelRadius * 2 + 0.03 + capH / 2, z,
  ));
}

interface CatalogKit {
  root: TransformNode;
  parts: Mesh[];
  bodyMat: PBRMaterial;
  glassMat: PBRMaterial;
  trimMat: StandardMaterial;
  wheelMat: StandardMaterial;
  lampMat: StandardMaterial;
  brakeMat: PBRMaterial;
  mats: Material[];
}

function catalogKit(scene: Scene, body: Color3, glass: Color3): CatalogKit {
  const root = new TransformNode('vehicle:root', scene);
  const bodyMat = paintMaterial(scene, 'vehicle:body', body);
  const glassMat = glassMaterial(scene, 'vehicle:glass', glass);
  const trimMat = material(scene, 'vehicle:trim', new Color3(0.12, 0.12, 0.13));
  const wheelMat = material(scene, 'vehicle:wheel', new Color3(0.09, 0.09, 0.1));
  const lampMat = material(scene, 'vehicle:lamp', new Color3(0.85, 0.78, 0.55), 0.22);
  const brakeMat = brakeLightMaterial(scene, 'vehicle:brake-lights');
  return { root, parts: [], bodyMat, glassMat, trimMat, wheelMat, lampMat, brakeMat, mats: [bodyMat, glassMat, trimMat, wheelMat, lampMat, brakeMat] };
}

function assembleCatalogBody(scene: Scene, kit: CatalogKit, layout: WheelLayout, wheelRadius: number, visual: FourWheelVisual, wheelWidth = 0.3): VehicleModel {
  const byMaterial = new Map<Material, Mesh[]>();
  for (const part of kit.parts) {
    const group = byMaterial.get(part.material as Material) ?? [];
    group.push(part);
    byMaterial.set(part.material as Material, group);
  }
  let groupIndex = 0;
  for (const group of byMaterial.values()) {
    const merged = group.length === 1 ? group[0]! : Mesh.MergeMeshes(group, true, true, undefined, false, false);
    if (!merged) throw new Error(`Could not merge ${visual} body`);
    merged.name = groupIndex++ === 0 ? `vehicle:body-${visual}` : `vehicle:detail-${visual}-${groupIndex}`;
    merged.parent = kit.root;
  }
  const offsets: readonly (readonly [number, number])[] = [
    [-layout.halfTrack, layout.front], [layout.halfTrack, layout.front],
    [-layout.halfTrack, -layout.rear], [layout.halfTrack, -layout.rear],
  ];
  const wheels = offsets.map(([x, z], i) => {
    const hub = new TransformNode(`vehicle:wheel-hub-${i}`, scene);
    hub.parent = kit.root;
    hub.position.set(x, wheelRadius, z);
    const tyre = CreateCylinder(`vehicle:wheel-${i}`, { height: wheelWidth, diameter: 2 * wheelRadius, tessellation: 14 }, scene);
    tyre.material = kit.wheelMat;
    tyre.rotation.z = Math.PI / 2;
    tyre.parent = hub;
    tyre.isPickable = false;
    tyre.receiveShadows = false;
    const hubCap = CreateCylinder(`vehicle:hub-cap-${i}`, { height: 0.07, diameterTop: wheelRadius * 0.62, diameterBottom: wheelRadius * 1.1, tessellation: 8 }, scene);
    hubCap.material = kit.bodyMat;
    hubCap.rotation.z = x > 0 ? -Math.PI / 2 : Math.PI / 2;
    hubCap.position.x = Math.sign(x) * (wheelWidth / 2);
    hubCap.parent = hub;
    hubCap.isPickable = false;
    hubCap.receiveShadows = false;
    return hub;
  });
  return {
    root: kit.root, wheels,
    setWheelPose: (spin, steer) => wheels.forEach((hub, i) => hub.rotation.set(spin, i < 2 ? steer : 0, 0)),
    setBrakeLights: (active) => setBrakeLightEmission(kit.brakeMat, active),
    setAppearance: () => {},
    dispose: () => { kit.root.dispose(false, true); kit.mats.forEach((mat) => mat.dispose()); },
  };
}

function spareRear(scene: Scene, kit: CatalogKit, wheelRadius: number, x: number, y: number, z: number): void {
  const spare = CreateCylinder('vehicle:spare-wheel', { height: 0.2, diameter: wheelRadius * 1.7, tessellation: 12 }, scene);
  spare.material = kit.wheelMat;
  spare.rotation.x = Math.PI / 2;
  spare.position.set(x, y, z);
  spare.isPickable = false;
  spare.receiveShadows = false;
  kit.parts.push(spare);
  const cover = box(scene, 'vehicle:spare-cover', kit.trimMat, wheelRadius * 0.9, wheelRadius * 0.9, 0.06, x, y, z + 0.12);
  kit.parts.push(cover);
}

// SUV utilitario genérico: fallback de catálogo si el GLB de cuatro puertas no carga.
function buildEstandarCatalog(scene: Scene, layout: WheelLayout, wheelRadius: number, size: VehicleBodySize, wheelWidth = 0.32): VehicleModel {
  const kit = catalogKit(scene, new Color3(0.18, 0.35, 0.22), new Color3(0.1, 0.17, 0.2));
  const width = catalogBodyWidth(size.widthM, layout.halfTrack, wheelWidth, 0.94);
  const halfW = width / 2;
  const length = size.lengthM;
  const chassisY = wheelRadius + 0.44;
  const chassisH = 0.55;
  const frontFace = 0.05 + (length * 0.96) / 2;
  const rearFace = 0.05 - (length * 0.96) / 2;
  kit.parts.push(slopedBox(scene, 'vehicle:estandar-chassis', kit.bodyMat, width, length * 0.96, width * 0.97, length * 0.94, chassisH, 0, chassisY, 0.05, 0.06, 0));
  const cabinL = length * 0.52;
  const cabinW = width * 0.88;
  const cabinY = chassisY + 0.58;
  // Techo recto con apenas corona: paredes casi verticales, perfil de caja alta.
  kit.parts.push(slopedBox(scene, 'vehicle:estandar-cabin', kit.bodyMat, cabinW, cabinL, width * 0.84, cabinL * 0.96, 0.62, 0, cabinY, -0.42, 0.05, 0.02));
  kit.parts.push(box(scene, 'vehicle:estandar-roof', kit.bodyMat, width * 0.84, 0.07, cabinL * 0.96, 0, cabinY + 0.33, -0.42));
  // Capó en cuña: morro bajo hacia la parrilla, cowl alto contra el parabrisas.
  const hoodD = length * 0.26;
  const hoodZ = length * 0.34;
  kit.parts.push(slopedBox(scene, 'vehicle:estandar-hood', kit.bodyMat, width * 0.96, hoodD, width * 0.9, length * 0.22, 0.18, 0, chassisY + 0.35, hoodZ, 0.1, 0));
  const shield = box(scene, 'vehicle:estandar-windshield', kit.glassMat, cabinW * 0.78, 0.4, 0.04, 0, cabinY + 0.04, cabinL * 0.5 - 0.42);
  shield.rotation.x = -0.18;
  kit.parts.push(shield);
  for (const side of [-1, 1] as const) {
    // 3 puertas: luna delantera larga + trasera corta con pilar grueso.
    kit.parts.push(box(scene, `vehicle:estandar-side-front-${side}`, kit.glassMat, 0.035, 0.34, 0.72, side * (cabinW / 2 - 0.005), cabinY + 0.04, -0.1));
    kit.parts.push(box(scene, `vehicle:estandar-side-rear-${side}`, kit.glassMat, 0.035, 0.34, 0.5, side * (cabinW / 2 - 0.005), cabinY + 0.04, -0.95));
    kit.parts.push(box(scene, `vehicle:estandar-pillar-${side}`, kit.trimMat, 0.045, 0.4, 0.09, side * (cabinW / 2 + 0.005), cabinY + 0.04, -0.58));
    kit.parts.push(box(scene, `vehicle:estandar-handle-${side}`, kit.trimMat, 0.04, 0.06, 0.18, side * (halfW + 0.005), chassisY + 0.3, -0.2));
    kit.parts.push(box(scene, `vehicle:estandar-mirror-${side}`, kit.trimMat, 0.14, 0.12, 0.18, side * (halfW + 0.05), cabinY + 0.1, 0.52));
    kit.parts.push(box(scene, `vehicle:estandar-step-${side}`, kit.trimMat, 0.18, 0.1, 1.5, side * (halfW + 0.02), wheelRadius + 0.2, -0.3));
    // Guardabarros: tapa el exterior del neumático, solapada con el lateral.
    kit.parts.push(taperedBox(scene, `vehicle:estandar-arch-f-${side}`, kit.trimMat, wheelWidth + 0.16, wheelRadius * 2.2 + 0.1, wheelWidth + 0.1, wheelRadius * 2.0 + 0.08, 0.14, side * layout.halfTrack, wheelRadius * 2 + 0.1, layout.front));
    kit.parts.push(taperedBox(scene, `vehicle:estandar-arch-r-${side}`, kit.trimMat, wheelWidth + 0.16, wheelRadius * 2.2 + 0.1, wheelWidth + 0.1, wheelRadius * 2.0 + 0.08, 0.14, side * layout.halfTrack, wheelRadius * 2 + 0.1, -layout.rear));
  }
  kit.parts.push(box(scene, 'vehicle:estandar-rear-glass', kit.glassMat, cabinW * 0.72, 0.32, 0.04, 0, cabinY + 0.04, -0.42 - cabinL / 2 + 0.01));
  kit.parts.push(box(scene, 'vehicle:estandar-grille', kit.trimMat, 0.8, 0.24, 0.05, 0, chassisY + 0.12, frontFace - 0.005));
  for (const side of [-1, 1] as const) {
    kit.parts.push(box(scene, `vehicle:estandar-headlamp-${side}`, kit.lampMat, 0.26, 0.18, 0.05, side * width * 0.3, chassisY + 0.14, frontFace - 0.005));
    kit.parts.push(box(scene, `vehicle:estandar-taillamp-${side}`, kit.brakeMat, 0.13, 0.26, 0.06, side * (halfW - 0.12), chassisY + 0.16, rearFace + 0.01));
  }
  kit.parts.push(box(scene, 'vehicle:estandar-bumper-f', kit.trimMat, width * 0.98, 0.2, 0.24, 0, wheelRadius + 0.12, frontFace + 0.06));
  kit.parts.push(box(scene, 'vehicle:estandar-bumper-r', kit.trimMat, width * 0.98, 0.2, 0.24, 0, wheelRadius + 0.12, rearFace - 0.06));
  // Repuesto centrado, embutido 4 cm en el portón para no flotar.
  spareRear(scene, kit, wheelRadius, 0, chassisY + 0.2, rearFace - 0.06);
  return assembleCatalogBody(scene, kit, layout, wheelRadius, 'estandar', wheelWidth);
}

// Nissan Patrol GR Y61: 5 puertas, más largo y cuadrado, techo alto, guardabarros anchos, gris/beige.
function buildPatrullaCatalog(scene: Scene, layout: WheelLayout, wheelRadius: number, size: VehicleBodySize, wheelWidth = 0.32): VehicleModel {
  const kit = catalogKit(scene, new Color3(0.68, 0.66, 0.58), new Color3(0.12, 0.18, 0.2));
  const width = catalogBodyWidth(size.widthM, layout.halfTrack, wheelWidth, 0.94);
  const halfW = width / 2;
  const length = size.lengthM;
  const chassisY = wheelRadius + 0.46;
  const chassisH = 0.58;
  const frontFace = (length * 1.0) / 2;
  const rearFace = -length / 2;
  kit.parts.push(slopedBox(scene, 'vehicle:patrulla-chassis', kit.bodyMat, width, length, width * 0.98, length * 0.99, chassisH, 0, chassisY, 0, 0.05, 0));
  const cabinL = length * 0.64;
  const cabinW = width * 0.9;
  const cabinY = chassisY + 0.6;
  // Cuadrado: paredes casi verticales y techo alto plano.
  kit.parts.push(taperedBox(scene, 'vehicle:patrulla-cabin', kit.bodyMat, cabinW, cabinL, width * 0.88, cabinL * 0.98, 0.66, 0, cabinY, -0.55));
  kit.parts.push(box(scene, 'vehicle:patrulla-roof', kit.bodyMat, width * 0.88, 0.08, cabinL * 0.98, 0, cabinY + 0.36, -0.55));
  // Capó alto y casi plano: morro de todo terreno grande con leve caída.
  kit.parts.push(slopedBox(scene, 'vehicle:patrulla-hood', kit.bodyMat, width * 0.96, length * 0.2, width * 0.94, length * 0.19, 0.2, 0, chassisY + 0.38, length * 0.38, 0.07, 0));
  const shield = box(scene, 'vehicle:patrulla-windshield', kit.glassMat, cabinW * 0.78, 0.42, 0.04, 0, cabinY + 0.04, cabinL * 0.5 - 0.55);
  shield.rotation.x = -0.08;
  kit.parts.push(shield);
  for (const side of [-1, 1] as const) {
    // 5 puertas: tres lunas laterales por lado.
    kit.parts.push(box(scene, `vehicle:patrulla-glass-a-${side}`, kit.glassMat, 0.035, 0.34, 0.5, side * (cabinW / 2 - 0.005), cabinY + 0.04, 0.05));
    kit.parts.push(box(scene, `vehicle:patrulla-glass-b-${side}`, kit.glassMat, 0.035, 0.34, 0.5, side * (cabinW / 2 - 0.005), cabinY + 0.04, -0.6));
    kit.parts.push(box(scene, `vehicle:patrulla-glass-c-${side}`, kit.glassMat, 0.035, 0.34, 0.5, side * (cabinW / 2 - 0.005), cabinY + 0.04, -1.25));
    kit.parts.push(box(scene, `vehicle:patrulla-pillar-ab-${side}`, kit.trimMat, 0.045, 0.4, 0.08, side * (cabinW / 2 + 0.005), cabinY + 0.04, -0.28));
    kit.parts.push(box(scene, `vehicle:patrulla-pillar-bc-${side}`, kit.trimMat, 0.045, 0.4, 0.08, side * (cabinW / 2 + 0.005), cabinY + 0.04, -0.93));
    // Guardabarros anchos sobre las cuatro ruedas, solapados con el lateral.
    archCap(scene, kit, kit.trimMat, `vehicle:patrulla-arch-f-${side}`, side * layout.halfTrack, layout.front, wheelRadius, wheelWidth);
    archCap(scene, kit, kit.trimMat, `vehicle:patrulla-arch-r-${side}`, side * layout.halfTrack, -layout.rear, wheelRadius, wheelWidth);
    kit.parts.push(box(scene, `vehicle:patrulla-handle-f-${side}`, kit.trimMat, 0.04, 0.06, 0.16, side * (halfW + 0.005), chassisY + 0.32, 0.0));
    kit.parts.push(box(scene, `vehicle:patrulla-handle-r-${side}`, kit.trimMat, 0.04, 0.06, 0.16, side * (halfW + 0.005), chassisY + 0.32, -0.75));
  }
  kit.parts.push(box(scene, 'vehicle:patrulla-tailgate', kit.bodyMat, width * 0.8, 0.5, 0.08, 0, chassisY + 0.35, rearFace + 0.02));
  kit.parts.push(box(scene, 'vehicle:patrulla-rear-glass', kit.glassMat, cabinW * 0.7, 0.3, 0.04, 0, cabinY + 0.06, rearFace + 0.05));
  kit.parts.push(box(scene, 'vehicle:patrulla-grille', kit.trimMat, 0.9, 0.26, 0.05, 0, chassisY + 0.14, frontFace - 0.005));
  for (const side of [-1, 1] as const) {
    kit.parts.push(box(scene, `vehicle:patrulla-headlamp-${side}`, kit.lampMat, 0.28, 0.2, 0.05, side * width * 0.3, chassisY + 0.16, frontFace - 0.005));
    kit.parts.push(box(scene, `vehicle:patrulla-taillamp-${side}`, kit.brakeMat, 0.14, 0.3, 0.06, side * (halfW - 0.12), chassisY + 0.2, rearFace + 0.01));
  }
  kit.parts.push(box(scene, 'vehicle:patrulla-bumper-f', kit.trimMat, width * 0.98, 0.2, 0.24, 0, wheelRadius + 0.12, frontFace + 0.06));
  kit.parts.push(box(scene, 'vehicle:patrulla-bumper-r', kit.trimMat, width * 0.98, 0.2, 0.24, 0, wheelRadius + 0.12, rearFace - 0.06));
  // Repuesto lateralizado a la izquierda (portón dividido del Y61), embutido en el portón.
  spareRear(scene, kit, wheelRadius, -0.35, chassisY + 0.22, rearFace - 0.04);
  return assembleCatalogBody(scene, kit, layout, wheelRadius, 'patrulla', wheelWidth);
}

// Jeep Wrangler TJ: 2 puertas muy corto, frontal vertical, faros redondos, parrilla 7 ranuras, techo duro, bisagras, amarillo.
function buildCargaCatalog(scene: Scene, layout: WheelLayout, wheelRadius: number, size: VehicleBodySize, wheelWidth = 0.32): VehicleModel {
  const kit = catalogKit(scene, new Color3(0.75, 0.58, 0.15), new Color3(0.1, 0.16, 0.19));
  const width = catalogBodyWidth(size.widthM, layout.halfTrack, wheelWidth, 0.9);
  const halfW = width / 2;
  // La bañera cubre los dos ejes con vuelo propio: largo mínimo por pisada.
  const tubLen = Math.max(size.lengthM * 0.8, layout.front + layout.rear + wheelRadius * 2 + 0.3);
  const tubZ = (layout.front - layout.rear) / 2;
  const frontFace = tubZ + tubLen / 2;
  const rearFace = tubZ - tubLen / 2;
  const chassisY = wheelRadius + 0.42;
  kit.parts.push(taperedBox(scene, 'vehicle:carga-tub', kit.bodyMat, width, tubLen * 0.98, width * 0.96, tubLen * 0.96, 0.5, 0, chassisY, tubZ));
  // Capó largo hasta el morro: del vuelo delantero al cowl, medio metro tras el eje.
  const hoodD = frontFace - layout.front + 0.5;
  const hoodZ = frontFace - hoodD / 2;
  // Cabina del cowl (solapado con el capó) casi hasta el portón: techo duro TJ.
  const cabinFront = hoodZ - hoodD / 2 + 0.07;
  const cabinRear = rearFace + 0.28;
  const cabinL = cabinFront - cabinRear;
  const cabinZ = (cabinFront + cabinRear) / 2;
  const cabinW = width * 0.86;
  const cabinY = chassisY + 0.52;
  // Techo duro desmontable: cabina corta con techo plano separado por junta.
  kit.parts.push(taperedBox(scene, 'vehicle:carga-hardtop', kit.bodyMat, cabinW, cabinL, width * 0.82, cabinL * 0.94, 0.55, 0, cabinY, cabinZ));
  kit.parts.push(box(scene, 'vehicle:carga-roof-seam', kit.trimMat, cabinW + 0.01, 0.05, cabinL * 0.95, 0, cabinY + 0.24, cabinZ));
  // Capó plano de Jeep: horizontal, contra el parabrisas vertical.
  kit.parts.push(taperedBox(scene, 'vehicle:carga-hood', kit.bodyMat, width * 0.9, hoodD, width * 0.88, hoodD * 0.98, 0.16, 0, chassisY + 0.32, hoodZ));
  // Frontal vertical con parrilla de 7 ranuras, embutida en el morro.
  kit.parts.push(box(scene, 'vehicle:carga-grille-panel', kit.trimMat, width * 0.7, 0.34, 0.06, 0, chassisY + 0.1, frontFace - 0.01));
  for (let slot = 0; slot < 7; slot++) {
    kit.parts.push(box(scene, `vehicle:carga-slot-${slot}`, kit.bodyMat, 0.07, 0.26, 0.02, (slot - 3) * 0.13, chassisY + 0.1, frontFace + 0.025));
  }
  for (const side of [-1, 1] as const) {
    const lamp = CreateCylinder(`vehicle:carga-roundlamp-${side}`, { height: 0.05, diameter: 0.24, tessellation: 12 }, scene);
    lamp.material = kit.lampMat;
    lamp.rotation.x = Math.PI / 2;
    lamp.position.set(side * width * 0.42, chassisY + 0.14, frontFace + 0.01);
    lamp.isPickable = false;
    lamp.receiveShadows = false;
    kit.parts.push(lamp);
    // Bisagras de capó y puertas + aletas planas solapadas con el lateral.
    kit.parts.push(box(scene, `vehicle:carga-hood-hinge-${side}`, kit.trimMat, 0.06, 0.1, 0.12, side * (halfW - 0.02), chassisY + 0.36, hoodZ + hoodD * 0.3));
    kit.parts.push(box(scene, `vehicle:carga-door-hinge-a-${side}`, kit.trimMat, 0.05, 0.09, 0.1, side * (halfW + 0.005), chassisY + 0.3, cabinZ + 0.25));
    kit.parts.push(box(scene, `vehicle:carga-door-hinge-b-${side}`, kit.trimMat, 0.05, 0.09, 0.1, side * (halfW + 0.005), chassisY + 0.1, cabinZ + 0.25));
    archCap(scene, kit, kit.bodyMat, `vehicle:carga-arch-f-${side}`, side * layout.halfTrack, layout.front, wheelRadius, wheelWidth);
    kit.parts.push(box(scene, `vehicle:carga-side-glass-${side}`, kit.glassMat, 0.035, 0.32, cabinL * 0.36, side * (cabinW / 2 - 0.005), cabinY + 0.04, cabinZ));
    kit.parts.push(box(scene, `vehicle:carga-mirror-${side}`, kit.trimMat, 0.12, 0.1, 0.16, side * (halfW + 0.04), cabinY + 0.08, hoodZ - 0.1));
  }
  const shield = box(scene, 'vehicle:carga-windshield', kit.glassMat, cabinW * 0.82, 0.38, 0.04, 0, cabinY + 0.04, cabinZ + cabinL / 2 - 0.01);
  shield.rotation.x = -0.05;
  kit.parts.push(shield);
  kit.parts.push(box(scene, 'vehicle:carga-bumper-f', kit.trimMat, width * 0.95, 0.18, 0.22, 0, wheelRadius + 0.1, frontFace + 0.08));
  kit.parts.push(box(scene, 'vehicle:carga-bumper-r', kit.trimMat, width * 0.95, 0.18, 0.22, 0, wheelRadius + 0.1, rearFace - 0.08));
  for (const side of [-1, 1] as const) {
    kit.parts.push(box(scene, `vehicle:carga-taillamp-${side}`, kit.brakeMat, 0.12, 0.2, 0.06, side * (halfW - 0.12), chassisY + 0.12, rearFace + 0.01));
    archCap(scene, kit, kit.bodyMat, `vehicle:carga-arch-r-${side}`, side * layout.halfTrack, -layout.rear, wheelRadius, wheelWidth);
  }
  spareRear(scene, kit, wheelRadius, 0, chassisY + 0.18, rearFace - 0.08);
  return assembleCatalogBody(scene, kit, layout, wheelRadius, 'carga', wheelWidth);
}

// Citroën AX: 3 puertas compacto estrecho y bajo, capó corto, hatch inclinado, molduras negras, rojo.
function buildExploradorCatalog(scene: Scene, layout: WheelLayout, wheelRadius: number, size: VehicleBodySize, wheelWidth = 0.32): VehicleModel {
  const kit = catalogKit(scene, new Color3(0.68, 0.15, 0.12), new Color3(0.11, 0.17, 0.2));
  const width = catalogBodyWidth(size.widthM, layout.halfTrack, wheelWidth, 0.95);
  const halfW = width / 2;
  const length = size.lengthM * 0.92;
  const frontFace = length / 2;
  const rearFace = -length / 2;
  const chassisY = wheelRadius + 0.3;
  kit.parts.push(slopedBox(scene, 'vehicle:explorador-body', kit.bodyMat, width, length, width * 0.9, length * 0.94, 0.4, 0, chassisY, 0, 0.06, 0.02));
  const cabinL = length * 0.48;
  const cabinW = width * 0.84;
  const cabinY = chassisY + 0.4;
  const cabinZ = -0.3;
  // Cabina en cuña: parabrisas tendido y luneta de hatch en un solo volumen.
  kit.parts.push(slopedBox(scene, 'vehicle:explorador-cabin', kit.bodyMat, cabinW, cabinL, width * 0.68, cabinL * 0.78, 0.42, 0, cabinY, cabinZ, 0.1, 0.06));
  const hoodD = length * 0.18;
  const hoodZ = length * 0.36;
  kit.parts.push(slopedBox(scene, 'vehicle:explorador-hood', kit.bodyMat, width * 0.88, hoodD, width * 0.78, length * 0.14, 0.12, 0, chassisY + 0.24, hoodZ, 0.08, 0));
  const shield = box(scene, 'vehicle:explorador-windshield', kit.glassMat, cabinW * 0.74, 0.32, 0.035, 0, cabinY + 0.06, cabinZ + cabinL * 0.42);
  shield.rotation.x = -0.34;
  kit.parts.push(shield);
  // Portón hatch inclinado: luna trasera muy tendida, embutida en la cuña.
  const hatch = box(scene, 'vehicle:explorador-hatch', kit.glassMat, cabinW * 0.7, 0.4, 0.035, 0, cabinY + 0.04, cabinZ - cabinL * 0.44);
  hatch.rotation.x = 0.5;
  kit.parts.push(hatch);
  for (const side of [-1, 1] as const) {
    // 3 puertas: luna lateral larga de una pieza + moldura negra ancha.
    kit.parts.push(box(scene, `vehicle:explorador-side-${side}`, kit.glassMat, 0.03, 0.28, cabinL * 0.6, side * (cabinW / 2 - 0.005), cabinY + 0.06, cabinZ + 0.02));
    kit.parts.push(box(scene, `vehicle:explorador-molding-${side}`, kit.trimMat, 0.04, 0.1, length * 0.62, side * (halfW + 0.005), chassisY + 0.05, -0.1));
    kit.parts.push(box(scene, `vehicle:explorador-bumper-mold-${side}`, kit.trimMat, 0.06, 0.12, 0.3, side * (halfW - 0.05), chassisY - 0.02, frontFace - 0.15));
    archCap(scene, kit, kit.trimMat, `vehicle:explorador-arch-f-${side}`, side * layout.halfTrack, layout.front, wheelRadius, wheelWidth);
    archCap(scene, kit, kit.trimMat, `vehicle:explorador-arch-r-${side}`, side * layout.halfTrack, -layout.rear, wheelRadius, wheelWidth);
  }
  kit.parts.push(box(scene, 'vehicle:explorador-bumper-f', kit.trimMat, width * 0.92, 0.16, 0.2, 0, wheelRadius + 0.06, frontFace - 0.04));
  kit.parts.push(box(scene, 'vehicle:explorador-bumper-r', kit.trimMat, width * 0.92, 0.16, 0.2, 0, wheelRadius + 0.06, rearFace + 0.04));
  for (const side of [-1, 1] as const) {
    kit.parts.push(box(scene, `vehicle:explorador-headlamp-${side}`, kit.lampMat, 0.3, 0.1, 0.04, side * width * 0.28, chassisY + 0.12, frontFace - 0.005));
    kit.parts.push(box(scene, `vehicle:explorador-taillamp-${side}`, kit.brakeMat, 0.1, 0.18, 0.04, side * (halfW - 0.1), chassisY + 0.1, rearFace + 0.005));
  }
  return assembleCatalogBody(scene, kit, layout, wheelRadius, 'explorador', wheelWidth);
}

// Audi A4 B5: berlina baja, morro largo, 3 volúmenes, 4 puertas con marcos, gris/plata.
function buildTurismoCatalog(scene: Scene, layout: WheelLayout, wheelRadius: number, size: VehicleBodySize, wheelWidth = 0.32): VehicleModel {
  const kit = catalogKit(scene, new Color3(0.68, 0.7, 0.72), new Color3(0.12, 0.18, 0.22));
  const width = catalogBodyWidth(size.widthM, layout.halfTrack, wheelWidth, 0.96);
  const halfW = width / 2;
  const length = size.lengthM;
  const frontFace = length / 2;
  const rearFace = -length / 2;
  const chassisY = wheelRadius + 0.28;
  kit.parts.push(slopedBox(scene, 'vehicle:turismo-body', kit.bodyMat, width, length, width * 0.92, length * 0.96, 0.38, 0, chassisY, 0, 0.05, 0.03));
  // Tres volúmenes: morro largo en cuña + cabina con corona + baúl con cola caída.
  const hoodD = length * 0.28;
  const hoodZ = length * 0.32;
  kit.parts.push(slopedBox(scene, 'vehicle:turismo-hood', kit.bodyMat, width * 0.9, hoodD, width * 0.8, length * 0.24, 0.14, 0, chassisY + 0.2, hoodZ, 0.09, 0));
  const cabinL = length * 0.4;
  const cabinW = width * 0.84;
  const cabinY = chassisY + 0.38;
  const cabinZ = -0.15;
  kit.parts.push(slopedBox(scene, 'vehicle:turismo-cabin', kit.bodyMat, cabinW, cabinL, width * 0.66, cabinL * 0.8, 0.4, 0, cabinY, cabinZ, 0.05, 0.05));
  const trunkD = length * 0.24;
  const trunkZ = rearFace + 0.02 + trunkD / 2;
  kit.parts.push(slopedBox(scene, 'vehicle:turismo-trunk', kit.bodyMat, width * 0.9, trunkD, width * 0.84, length * 0.22, 0.18, 0, chassisY + 0.26, trunkZ, 0.01, 0.07));
  // Labio de tapa de baúl: rompe la trasera plana vista desde atrás.
  kit.parts.push(box(scene, 'vehicle:turismo-trunk-lip', kit.bodyMat, width * 0.7, 0.05, 0.1, 0, chassisY + 0.3, rearFace + 0.12));
  const shield = box(scene, 'vehicle:turismo-windshield', kit.glassMat, cabinW * 0.76, 0.3, 0.035, 0, cabinY + 0.06, cabinZ + cabinL * 0.44);
  shield.rotation.x = -0.35;
  kit.parts.push(shield);
  const rearGlass = box(scene, 'vehicle:turismo-backlight', kit.glassMat, cabinW * 0.72, 0.26, 0.035, 0, cabinY + 0.06, cabinZ - cabinL * 0.44);
  rearGlass.rotation.x = 0.35;
  kit.parts.push(rearGlass);
  for (const side of [-1, 1] as const) {
    // Cuatro puertas: dos lunas por lado con marco y pilar B.
    kit.parts.push(box(scene, `vehicle:turismo-glass-f-${side}`, kit.glassMat, 0.03, 0.26, 0.52, side * (cabinW / 2 - 0.005), cabinY + 0.06, 0.12));
    kit.parts.push(box(scene, `vehicle:turismo-glass-r-${side}`, kit.glassMat, 0.03, 0.26, 0.5, side * (cabinW / 2 - 0.005), cabinY + 0.06, -0.48));
    kit.parts.push(box(scene, `vehicle:turismo-frame-f-${side}`, kit.trimMat, 0.04, 0.3, 0.56, side * (cabinW / 2 + 0.005), cabinY + 0.06, 0.12));
    kit.parts.push(box(scene, `vehicle:turismo-pillar-b-${side}`, kit.trimMat, 0.04, 0.3, 0.07, side * (cabinW / 2 + 0.005), cabinY + 0.06, -0.18));
    kit.parts.push(box(scene, `vehicle:turismo-handle-f-${side}`, kit.trimMat, 0.035, 0.05, 0.14, side * (halfW + 0.005), chassisY + 0.22, 0.1));
    kit.parts.push(box(scene, `vehicle:turismo-handle-r-${side}`, kit.trimMat, 0.035, 0.05, 0.14, side * (halfW + 0.005), chassisY + 0.22, -0.45));
    kit.parts.push(box(scene, `vehicle:turismo-seam-${side}`, kit.trimMat, 0.025, 0.34, 0.025, side * (halfW - 0.005), chassisY + 0.16, -0.18));
    archCap(scene, kit, kit.bodyMat, `vehicle:turismo-arch-f-${side}`, side * layout.halfTrack, layout.front, wheelRadius, wheelWidth);
    archCap(scene, kit, kit.bodyMat, `vehicle:turismo-arch-r-${side}`, side * layout.halfTrack, -layout.rear, wheelRadius, wheelWidth);
  }
  kit.parts.push(box(scene, 'vehicle:turismo-grille', kit.trimMat, 0.6, 0.12, 0.04, 0, chassisY + 0.06, frontFace - 0.005));
  for (const side of [-1, 1] as const) {
    kit.parts.push(box(scene, `vehicle:turismo-headlamp-${side}`, kit.lampMat, 0.32, 0.1, 0.04, side * width * 0.3, chassisY + 0.1, frontFace - 0.005));
    // Trasera ancha B5: piloto exterior + tira central en una sola barra de luz.
    kit.parts.push(box(scene, `vehicle:turismo-taillamp-${side}`, kit.brakeMat, 0.34, 0.1, 0.04, side * (halfW - 0.2), chassisY + 0.22, rearFace + 0.005));
    // Doble escape embutido en el faldón trasero.
    kit.parts.push(box(scene, `vehicle:turismo-exhaust-${side}`, kit.trimMat, 0.09, 0.07, 0.1, side * 0.28, wheelRadius + 0.02, rearFace + 0.02));
  }
  kit.parts.push(box(scene, 'vehicle:turismo-lightbar', kit.brakeMat, width * 0.34, 0.08, 0.03, 0, chassisY + 0.22, rearFace + 0.008));
  kit.parts.push(box(scene, 'vehicle:turismo-bumper-f', kit.trimMat, width * 0.96, 0.16, 0.2, 0, wheelRadius + 0.04, frontFace - 0.04));
  kit.parts.push(box(scene, 'vehicle:turismo-valance-r', kit.trimMat, width * 0.96, 0.16, 0.2, 0, wheelRadius + 0.04, rearFace + 0.04));
  return assembleCatalogBody(scene, kit, layout, wheelRadius, 'turismo', wheelWidth);
}

// Tesla Model 3: berlina EV aerodinámica, morro cerrado, parabrisas y techo de vidrio largos, blanco/azul.
function buildRallyCatalog(scene: Scene, layout: WheelLayout, wheelRadius: number, size: VehicleBodySize, wheelWidth = 0.32): VehicleModel {
  const kit = catalogKit(scene, new Color3(0.86, 0.88, 0.9), new Color3(0.25, 0.38, 0.5));
  const width = catalogBodyWidth(size.widthM, layout.halfTrack, wheelWidth, 0.96);
  const halfW = width / 2;
  const length = size.lengthM;
  const frontFace = length / 2;
  const rearFace = -length / 2;
  const chassisY = wheelRadius + 0.26;
  // Perfiles lisos: bajos redondeados con cuña de morro y cola.
  kit.parts.push(slopedBox(scene, 'vehicle:rally-body', kit.bodyMat, width, length, width * 0.88, length * 0.9, 0.36, 0, chassisY, 0, 0.08, 0.05));
  const noseD = length * 0.2;
  const noseZ = length * 0.38;
  kit.parts.push(slopedBox(scene, 'vehicle:rally-nose', kit.bodyMat, width * 0.86, noseD, width * 0.74, length * 0.14, 0.14, 0, chassisY + 0.18, noseZ, 0.1, 0));
  const cabinL = length * 0.55;
  const cabinW = width * 0.82;
  const cabinY = chassisY + 0.32;
  const cabinZ = -0.25;
  kit.parts.push(slopedBox(scene, 'vehicle:rally-cabin', kit.bodyMat, cabinW, cabinL, width * 0.68, cabinL * 0.82, 0.34, 0, cabinY, cabinZ, 0.06, 0.06));
  // Parabrisas y techo de vidrio largos en una banda continua.
  const shield = box(scene, 'vehicle:rally-windshield', kit.glassMat, cabinW * 0.74, 0.34, 0.035, 0, cabinY + 0.1, cabinZ + cabinL * 0.36);
  shield.rotation.x = -0.42;
  kit.parts.push(shield);
  kit.parts.push(box(scene, 'vehicle:rally-glass-roof', kit.glassMat, cabinW * 0.72, 0.035, cabinL * 0.52, 0, cabinY + 0.16, cabinZ - 0.05));
  const rearGlass = box(scene, 'vehicle:rally-backlight', kit.glassMat, cabinW * 0.7, 0.3, 0.035, 0, cabinY + 0.1, cabinZ - cabinL * 0.4);
  rearGlass.rotation.x = 0.42;
  kit.parts.push(rearGlass);
  for (const side of [-1, 1] as const) {
    // Sin molduras: solo manillas enrasadas y faldones lisos.
    kit.parts.push(box(scene, `vehicle:rally-side-glass-${side}`, kit.glassMat, 0.03, 0.24, cabinL * 0.5, side * (cabinW / 2 - 0.005), cabinY + 0.08, cabinZ - 0.03));
    kit.parts.push(box(scene, `vehicle:rally-flush-handle-${side}`, kit.trimMat, 0.03, 0.03, 0.16, side * (halfW - 0.005), chassisY + 0.24, -0.2));
    kit.parts.push(box(scene, `vehicle:rally-skirt-${side}`, kit.bodyMat, 0.08, 0.1, length * 0.5, side * (halfW - 0.02), chassisY - 0.08, -0.1));
    archCap(scene, kit, kit.bodyMat, `vehicle:rally-arch-f-${side}`, side * layout.halfTrack, layout.front, wheelRadius, wheelWidth);
    archCap(scene, kit, kit.bodyMat, `vehicle:rally-arch-r-${side}`, side * layout.halfTrack, -layout.rear, wheelRadius, wheelWidth);
  }
  // Morro sin parrilla abierta: solo toma baja y faros finos.
  kit.parts.push(box(scene, 'vehicle:rally-intake', kit.trimMat, width * 0.6, 0.07, 0.04, 0, chassisY - 0.04, frontFace - 0.005));
  for (const side of [-1, 1] as const) {
    kit.parts.push(box(scene, `vehicle:rally-headlamp-${side}`, kit.lampMat, 0.34, 0.07, 0.04, side * width * 0.28, chassisY + 0.12, frontFace - 0.01));
    kit.parts.push(box(scene, `vehicle:rally-taillamp-${side}`, kit.brakeMat, 0.3, 0.06, 0.04, side * (halfW - 0.2), chassisY + 0.14, rearFace + 0.005));
  }
  // Barra de luz trasera de ancho completo + labio de baúl.
  kit.parts.push(box(scene, 'vehicle:rally-lightbar', kit.brakeMat, width * 0.5, 0.06, 0.03, 0, chassisY + 0.14, rearFace + 0.008));
  kit.parts.push(box(scene, 'vehicle:rally-lip', kit.bodyMat, width * 0.7, 0.05, 0.18, 0, chassisY + 0.16, rearFace + 0.06));
  return assembleCatalogBody(scene, kit, layout, wheelRadius, 'rally', wheelWidth);
}

function createCatalogBody(scene: Scene, layout: WheelLayout, wheelRadius: number, visual: FourWheelVisual, size: VehicleBodySize, wheelWidth = 0.32,
  onMeshesReplaced?: (removed: readonly AbstractMesh[], added: readonly AbstractMesh[]) => void): VehicleModel {
  if (visual === 'estandar' || visual === 'patrulla') {
    return buildUtilityWithGlbFallback(scene, layout, wheelRadius, size, wheelWidth, visual, onMeshesReplaced);
  }
  switch (visual) {
    case 'carga':
      return buildCargaCatalog(scene, layout, wheelRadius, size, wheelWidth);
    case 'explorador':
      return buildExploradorCatalog(scene, layout, wheelRadius, size, wheelWidth);
    case 'turismo':
      return buildTurismoCatalog(scene, layout, wheelRadius, size, wheelWidth);
    case 'rally':
      return buildRallyCatalog(scene, layout, wheelRadius, size, wheelWidth);
  }
}

/** Uses the sourced generic utility SUV when it loads; the catalog silhouette remains a visible fallback. */
function buildUtilityWithGlbFallback(scene: Scene, layout: WheelLayout, wheelRadius: number,
  size: VehicleBodySize, wheelWidth: number, visual: 'estandar' | 'patrulla',
  onMeshesReplaced?: (removed: readonly AbstractMesh[], added: readonly AbstractMesh[]) => void): VehicleModel {
  const fallback = visual === 'estandar'
    ? buildEstandarCatalog(scene, layout, wheelRadius, size, wheelWidth)
    : buildPatrullaCatalog(scene, layout, wheelRadius, size, wheelWidth);
  const sourceScale = { x: 0.77, y: 0.9, z: 0.84 };
  const url = publicUrl('/vehicles/four-door-utility.glb');
  const assetRoot = new TransformNode(`vehicle:${visual}-glb-root`, scene);
  assetRoot.parent = fallback.root;
  assetRoot.scaling.set(sourceScale.x, sourceScale.y, sourceScale.z);
  assetRoot.position.y = -wheelRadius;
  assetRoot.setEnabled(false);

  const wheelNames = ['wheel-lf', 'wheel-rf', 'wheel-lr', 'wheel-rr'] as const;
  const glbWheels: TransformNode[] = [];
  let braking = false;
  let glbBrakeMaterials: Array<{
    material: PBRMaterial;
    albedo: Color3;
    emissive: Color3;
    intensity: number;
  }> = [];
  const applyGlbBrakeLights = (active: boolean): void => {
    for (const lamp of glbBrakeMaterials) {
      lamp.material.albedoColor = active ? new Color3(0.82, 0.025, 0.012) : lamp.albedo;
      lamp.material.emissiveColor = active ? new Color3(1, 0.01, 0.002) : lamp.emissive;
      lamp.material.emissiveIntensity = active ? 2.4 : lamp.intensity;
    }
  };
  let container: Awaited<ReturnType<typeof SceneLoader.LoadAssetContainerAsync>> | null = null;
  let disposed = false;

  void SceneLoader.LoadAssetContainerAsync('', url, scene).then((loaded) => {
    if (disposed) {
      loaded.dispose();
      return;
    }
    const pivots = wheelNames.map((name) => loaded.transformNodes.find((node) => node.name === name));
    const drawableMeshes = loaded.meshes.filter((mesh) => mesh.getTotalVertices() > 0);
    if (pivots.some((pivot) => !pivot) || drawableMeshes.length < 10) {
      loaded.dispose();
      throw new Error('Utility SUV GLB must contain four named wheel pivots and a detailed body');
    }

    glbBrakeMaterials = loaded.materials.flatMap((candidate) => {
      if (candidate.name !== 'orange' || !('albedoColor' in candidate) || !('emissiveColor' in candidate)) return [];
      const lamp = candidate as PBRMaterial;
      return [{
        material: lamp,
        albedo: lamp.albedoColor.clone(),
        emissive: lamp.emissiveColor.clone(),
        intensity: lamp.emissiveIntensity,
      }];
    });
    if (glbBrakeMaterials.length === 0) {
      loaded.dispose();
      throw new Error('Utility SUV GLB must provide its rear lamp material named "orange"');
    }

    loaded.animationGroups.forEach((group) => group.dispose());
    loaded.addAllToScene();
    for (const node of loaded.rootNodes) {
      if (node instanceof TransformNode) node.parent = assetRoot;
    }
    const pivotByName = new Map(pivots.map((pivot, index) => [wheelNames[index]!, pivot!]));
    const positions = [
      [-layout.halfTrack, layout.front], [layout.halfTrack, layout.front],
      [-layout.halfTrack, -layout.rear], [layout.halfTrack, -layout.rear],
    ] as const;
    for (let index = 0; index < wheelNames.length; index++) {
      const wheel = pivotByName.get(wheelNames[index]!)!;
      const [x, z] = positions[index]!;
      // Lower the tire center back to the terrain support height after the
      // parent model root is lowered to align the chassis.
      wheel.position.set(x / sourceScale.x, (2 * wheelRadius) / sourceScale.y, z / sourceScale.z);
      wheel.rotation.set(0, 0, 0);
      glbWheels.push(wheel);
    }

    // Transfer ownership of the visible shell to the GLB. Physics hubs remain
    // in place but their prototype tires/caps are removed to avoid duplicates.
    const removed = fallback.root.getChildMeshes(false).filter((mesh) => mesh.name.startsWith('vehicle:'));
    for (const mesh of removed) mesh.dispose(false, false);
    assetRoot.setEnabled(true);
    applyGlbBrakeLights(braking);
    container = loaded;
    onMeshesReplaced?.(removed, fallback.root.getChildMeshes());
  }).catch((error: unknown) => {
    if (!disposed) console.error(`[vehicle] Failed to load ${url}; retaining the procedural ${visual} fallback`, error);
  });

  return {
    ...fallback,
    setWheelPose: (spin, steer) => {
      fallback.setWheelPose(spin, steer);
      for (let index = 0; index < glbWheels.length; index++) {
        glbWheels[index]!.rotation.set(spin, index < 2 ? steer : 0, 0);
      }
    },
    setBrakeLights: (active) => {
      braking = active;
      fallback.setBrakeLights(active);
      applyGlbBrakeLights(active);
    },
    dispose: () => {
      disposed = true;
      container?.dispose();
      fallback.dispose();
    },
  };
}

export function createVehicleModel(scene: Scene, layout: WheelLayout, wheelRadius: number, wheelWidth = 0.32,
  visual?: FourWheelVisual, bodySize?: VehicleBodySize,
  onMeshesReplaced?: (removed: readonly AbstractMesh[], added: readonly AbstractMesh[]) => void): VehicleModel {
  if (visual && bodySize) {
    return createCatalogBody(scene, layout, wheelRadius, visual, bodySize, wheelWidth, onMeshesReplaced);
  }
  const root = new TransformNode('vehicle:root', scene);

  // Paleta de vehículo de trabajo rural: verde aceituna apagado, negro mate y
  // cristales oscuros. Se reutilizan los materiales existentes para no sumar
  // llamadas de dibujo.
  const bodyMat = paintMaterial(scene, 'vehicle:body', new Color3(0.4, 0.43, 0.32));
  const cabinMat = glassMaterial(scene, 'vehicle:glass', new Color3(0.11, 0.19, 0.2));
  const trimMat = material(scene, 'vehicle:trim', new Color3(0.14, 0.14, 0.15), 0.06);
  const wheelMat = material(scene, 'vehicle:wheel', new Color3(0.13, 0.13, 0.14), 0.06);
  const lampMat = material(scene, 'vehicle:lamp', new Color3(0.85, 0.77, 0.55), 0.22);
  const brakeMat = brakeLightMaterial(scene, 'vehicle:brake-lights');

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
  parts.push(box(scene, 'vehicle:taillamp-left', brakeMat, 0.14, 0.24, 0.05, -0.66, chassisY + 0.14, -2.03));
  parts.push(box(scene, 'vehicle:taillamp-right', brakeMat, 0.14, 0.24, 0.05, 0.66, chassisY + 0.14, -2.03));
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
  const staticByMaterial = new Map<Material, Mesh[]>();
  for (const part of parts) {
    const group = staticByMaterial.get(part.material as Material) ?? [];
    group.push(part);
    staticByMaterial.set(part.material as Material, group);
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

  // Cada actor expone su carrocería base como `vehicle:body-<id>`: la llamada
  // legada sin definición sigue siendo `estandar`; las variantes conservan su id.
  root.getChildMeshes().find((mesh) => mesh.name === 'vehicle:static-0')!.name = `vehicle:body-${visual ?? 'estandar'}`;
  if (visual && bodySize) {
    if (visual !== 'patrulla') patrolKit.dispose();
    if (visual !== 'carga') cargoKit.dispose();
    if (visual === 'patrulla') patrolKit.setEnabled(true);
    if (visual === 'carga') cargoKit.setEnabled(true);
    bodyMat.albedoColor = visual === 'patrulla'
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
    setBrakeLights: (active) => setBrakeLightEmission(brakeMat, active),
    setAppearance: (id) => {
      patrolKit.setEnabled(id === 'patrulla');
      cargoKit.setEnabled(id === 'carga');
      bodyMat.albedoColor = id === 'patrulla'
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
      brakeMat.dispose();
    },
  };
}
