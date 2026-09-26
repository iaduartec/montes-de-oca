/**
 * El objetivo de la misión: un repetidor de telecomunicaciones FICTICIO al fondo
 * de la pista. ACÁ sí se usa Babylon (es la parte visible). Modelo PROCEDURAL:
 * primitivas + `StandardMaterial` plano, sin texturas ni GLTF.
 *
 * Por qué procedural y ficticio: es infraestructura de juego, no un activo real.
 * Una torre liviana se arma con cilindros/cajas y da la lectura "técnico" sin
 * depender de assets. Y como es ficción, no hay riesgo de representar una
 * instalación sensible real.
 *
 * REGLA DE ORO DE LA BASE: el mundo es Y-up y el terreno tiene pendiente. La base
 * se ancla en el MÍNIMO `heightAt` de la huella y se agrega un patín (losa) que
 * baja por debajo: así NUNCA queda flotando (el error clásico de apoyar en el
 * centro y que las esquinas queden en el aire). No se reimplementa interpolación:
 * la altura se pide SIEMPRE a `terrain.heightAt`.
 */
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import { CreateBox } from '@babylonjs/core/Meshes/Builders/boxBuilder';
import { CreateCylinder } from '@babylonjs/core/Meshes/Builders/cylinderBuilder';
import { CreateSphere } from '@babylonjs/core/Meshes/Builders/sphereBuilder';
import { CreateDisc } from '@babylonjs/core/Meshes/Builders/discBuilder';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import { Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector';
import type { Scene } from '@babylonjs/core/scene';
import type { Mesh } from '@babylonjs/core/Meshes/mesh';
import type { WorldTerrain } from '../terrain';
import type { Interactable } from './interact';

export interface Objective {
  readonly root: TransformNode;
  readonly interactable: Interactable;
  /** 0..1: retroalimentación visual del progreso de reparación. */
  setRepairProgress(progress: number): void;
  dispose(): void;
}

export interface CreateObjectiveOptions {
  readonly at: { readonly x: number; readonly z: number; readonly yaw: number };
  readonly clearRadiusM: number;
}

const PAD_HALF_M = 3.2;

/** Color de la baliza: rojo apagado hasta reparar, verde encendido al reparar. */
const BEACON_OFF_DIFFUSE = new Color3(0.45, 0.05, 0.03);
const BEACON_ON_DIFFUSE = new Color3(0.2, 0.95, 0.35);
const BEACON_OFF_EMISSIVE = new Color3(0.32, 0.02, 0.01);
const BEACON_ON_EMISSIVE = new Color3(0.25, 1.0, 0.45);

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** Material plano del proyecto: difuso + ambiente, especular casi nulo. */
function material(scene: Scene, name: string, color: Color3, specular = 0.08): StandardMaterial {
  const mat = new StandardMaterial(name, scene);
  mat.diffuseColor = color;
  mat.specularColor = new Color3(specular, specular, specular);
  mat.ambientColor = new Color3(0.18, 0.18, 0.18);
  return mat;
}

interface BuildContext {
  readonly scene: Scene;
  readonly root: TransformNode;
  readonly parts: Mesh[];
}

function box(
  ctx: BuildContext,
  name: string,
  mat: StandardMaterial,
  width: number,
  height: number,
  depth: number,
  x: number,
  y: number,
  z: number,
): Mesh {
  const mesh = CreateBox(name, { width, height, depth }, ctx.scene);
  mesh.material = mat;
  mesh.parent = ctx.root;
  mesh.position.set(x, y, z);
  mesh.isPickable = false;
  mesh.receiveShadows = true;
  ctx.parts.push(mesh);
  return mesh;
}

/** Cilindro vertical (eje Y) en coordenadas locales. */
function column(
  ctx: BuildContext,
  name: string,
  mat: StandardMaterial,
  height: number,
  diameter: number,
  x: number,
  y: number,
  z: number,
  tessellation = 10,
): Mesh {
  const mesh = CreateCylinder(name, { height, diameter, tessellation }, ctx.scene);
  mesh.material = mat;
  mesh.parent = ctx.root;
  mesh.position.set(x, y, z);
  mesh.isPickable = false;
  mesh.receiveShadows = true;
  ctx.parts.push(mesh);
  return mesh;
}

/**
 * Barra/riostra entre dos puntos locales: crea el cilindro con la longitud justa
 * y lo orienta con un cuaternión desde el eje Y hasta la dirección. Sin esto, una
 * riostra diagonal sólo se puede dibujar "a ojo" con rotaciones manuales.
 */
function strut(
  ctx: BuildContext,
  name: string,
  mat: StandardMaterial,
  from: Vector3,
  to: Vector3,
  thickness: number,
): Mesh | null {
  const delta = to.subtract(from);
  const length = delta.length();
  if (length < 1e-6) return null;
  const unit = delta.scale(1 / length);
  const mesh = CreateCylinder(name, { height: length, diameter: thickness, tessellation: 6 }, ctx.scene);
  mesh.material = mat;
  mesh.parent = ctx.root;
  mesh.position.copyFrom(from.add(to).scale(0.5));
  const axis = Vector3.Cross(Vector3.Up(), unit);
  if (axis.lengthSquared() < 1e-8) {
    // Riostra vertical exacta: el cross da cero, sólo importa el sentido.
    mesh.rotation = unit.y >= 0 ? Vector3.Zero() : new Vector3(Math.PI, 0, 0);
  } else {
    axis.normalize();
    const angle = Math.acos(Math.max(-1, Math.min(1, Vector3.Dot(Vector3.Up(), unit))));
    mesh.rotationQuaternion = Quaternion.RotationAxis(axis, angle);
  }
  mesh.isPickable = false;
  mesh.receiveShadows = true;
  ctx.parts.push(mesh);
  return mesh;
}

/** Puntos de la huella (local → mundo) para hallar el mínimo del terreno. */
function footprintPoints(half: number): readonly (readonly [number, number])[] {
  return [
    [0, 0],
    [-half, -half],
    [half, -half],
    [-half, half],
    [half, half],
    [-half, 0],
    [half, 0],
    [0, -half],
    [0, half],
  ];
}

export function createRepeaterObjective(scene: Scene, terrain: WorldTerrain, options: CreateObjectiveOptions): Objective {
  const { at, clearRadiusM } = options;
  const cos = Math.cos(at.yaw);
  const sin = Math.sin(at.yaw);

  // La base toca el terreno: mínimo de la huella rotada por la guiñada. Se usa la
  // MISMA rotación de Babylon (rotation.y) para que patín y terreno coincidan.
  let minHeight = Infinity;
  for (const [lx, lz] of footprintPoints(PAD_HALF_M)) {
    const wx = at.x + lx * cos + lz * sin;
    const wz = at.z - lx * sin + lz * cos;
    const h = terrain.heightAt(wx, wz);
    if (h < minHeight) minHeight = h;
  }

  const root = new TransformNode('objective:repeater', scene);
  root.position.set(at.x, minHeight, at.z);
  root.rotation.y = at.yaw;

  const concreteMat = material(scene, 'objective:concrete', new Color3(0.55, 0.55, 0.53), 0.04);
  const towerMat = material(scene, 'objective:tower', new Color3(0.72, 0.74, 0.78), 0.2);
  const cabinetMat = material(scene, 'objective:cabinet', new Color3(0.84, 0.85, 0.87), 0.12);
  const cabinetDetailMat = material(scene, 'objective:cabinet-detail', new Color3(0.26, 0.3, 0.29), 0.08);
  const cabinetHardwareMat = material(scene, 'objective:cabinet-hardware', new Color3(0.62, 0.58, 0.45), 0.1);
  const dishMat = material(scene, 'objective:dish', new Color3(0.9, 0.9, 0.88), 0.25);
  dishMat.backFaceCulling = false;
  const beaconMat = material(scene, 'objective:beacon', BEACON_OFF_DIFFUSE.clone(), 0.2);
  beaconMat.emissiveColor = BEACON_OFF_EMISSIVE.clone();
  const indicatorMat = material(scene, 'objective:indicator', new Color3(0.5, 0.06, 0.04), 0.1);
  indicatorMat.emissiveColor = new Color3(0.3, 0.02, 0.01);

  const materials = [concreteMat, towerMat, cabinetMat, cabinetDetailMat, cabinetHardwareMat, dishMat, beaconMat, indicatorMat];
  const ctx: BuildContext = { scene, root, parts: [] };

  // Patín: centro en y=-0.2 con 1.0 de alto ⇒ tope en +0.3 y fondo en -0.7, por
  // debajo del mínimo del terreno. En pendiente el borde queda enterrado, nunca
  // en el aire.
  box(ctx, 'objective:pad', concreteMat, PAD_HALF_M * 2, 1.0, PAD_HALF_M * 2, 0, -0.2, 0);

  // Anclajes de las riostras, dentro del radio libre.
  const anchorRadius = Math.max(2.5, Math.min(5, clearRadiusM * 0.25));
  for (let i = 0; i < 4; i++) {
    const angle = (i / 4) * Math.PI * 2 + Math.PI / 4;
    box(ctx, `objective:anchor-${i}`, concreteMat, 0.6, 0.5, 0.6, Math.cos(angle) * anchorRadius, 0.25, Math.sin(angle) * anchorRadius);
  }

  // Mástil de 12 m y 4 riostras desde cerca de la punta.
  const mastTop = 12.3;
  column(ctx, 'objective:mast', towerMat, 12, 0.36, 0, 0.3 + 6, 0, 12);
  const stayTop = new Vector3(0, mastTop - 1.1, 0);
  for (let i = 0; i < 4; i++) {
    const angle = (i / 4) * Math.PI * 2 + Math.PI / 4;
    strut(
      ctx,
      `objective:stay-${i}`,
      towerMat,
      stayTop,
      new Vector3(Math.cos(angle) * anchorRadius, 0.5, Math.sin(angle) * anchorRadius),
      0.06,
    );
  }
  // Travesaños horizontales para la lectura de celosía.
  box(ctx, 'objective:brace-a', towerMat, 2.4, 0.1, 0.1, 0, 7.0, 0);
  box(ctx, 'objective:brace-b', towerMat, 1.8, 0.1, 0.1, 0, 10.2, 0);

  // Armario técnico con puerta y ventilación: los detalles oscuros rompen el
  // bloque gris a corta distancia sin textura ni materiales por ventana.
  box(ctx, 'objective:cabinet', cabinetMat, 1.4, 1.8, 0.9, 2.1, 1.2, 1.4);
  box(ctx, 'objective:cabinet-service-door', cabinetDetailMat, 1.1, 1.48, 0.035, 2.1, 1.2, 0.929);
  for (let vent = 0; vent < 4; vent++) {
    box(ctx, `objective:cabinet-vent-${vent}`, cabinetHardwareMat, 0.34, 0.035, 0.025, 1.83, 0.92 + vent * 0.11, 0.9);
  }
  box(ctx, 'objective:cabinet-handle', cabinetHardwareMat, 0.055, 0.19, 0.045, 2.54, 1.2, 0.898);
  box(ctx, 'objective:cabinet-lock', cabinetHardwareMat, 0.07, 0.07, 0.035, 2.53, 1.2, 0.89);
  box(ctx, 'objective:cabinet-indicator', indicatorMat, 0.16, 0.12, 0.05, 2.1, 1.95, 0.88);

  // Antena: brazo + reflector que GIRA con el progreso. Es la señal visual más
  // clara de "se está reparando" junto con la baliza.
  const antennaMount = new TransformNode('objective:antenna-mount', scene);
  antennaMount.parent = root;
  antennaMount.position.set(0, 8.7, 0);
  const boom = CreateBox('objective:antenna-boom', { width: 0.12, height: 0.12, depth: 1.2 }, scene);
  boom.material = towerMat;
  boom.parent = antennaMount;
  boom.position.set(0, 0, 0.6);
  boom.isPickable = false;
  ctx.parts.push(boom);
  const dish = CreateDisc('objective:antenna-dish', { radius: 0.7, tessellation: 16 }, scene);
  dish.material = dishMat;
  dish.parent = antennaMount;
  dish.position.set(0, 0, 1.2);
  dish.isPickable = false;
  ctx.parts.push(dish);

  // Baliza en la punta.
  const beacon = CreateSphere('objective:beacon', { diameter: 0.56, segments: 10 }, scene);
  beacon.material = beaconMat;
  beacon.parent = root;
  beacon.position.set(0, mastTop + 0.25, 0);
  beacon.isPickable = false;
  ctx.parts.push(beacon);

  return {
    root,
    interactable: {
      id: 'repeater',
      label: 'Repetidor sin señal',
      x: at.x,
      z: at.z,
      radiusM: 6,
    },
    setRepairProgress: (progress: number): void => {
      const k = clamp01(progress);
      // Baliza y piloto se encienden gradualmente: rojo → verde. En k=1 queda
      // plenamente verde y emisiva (el "reparado" visible desde la pista).
      Color3.LerpToRef(BEACON_OFF_DIFFUSE, BEACON_ON_DIFFUSE, k, beaconMat.diffuseColor);
      Color3.LerpToRef(BEACON_OFF_EMISSIVE, BEACON_ON_EMISSIVE, k, beaconMat.emissiveColor);
      Color3.LerpToRef(new Color3(0.5, 0.06, 0.04), new Color3(0.15, 0.9, 0.3), k, indicatorMat.diffuseColor);
      Color3.LerpToRef(new Color3(0.3, 0.02, 0.01), new Color3(0.2, 0.95, 0.4), k, indicatorMat.emissiveColor);
      // La antena gira media vuelta durante la reparación: movimiento inequívoco.
      antennaMount.rotation.y = k * Math.PI;
      beacon.scaling.setAll(1 + 0.35 * k);
    },
    dispose: (): void => {
      for (const part of ctx.parts) part.dispose();
      for (const mat of materials) mat.dispose();
      root.dispose();
    },
  };
}
