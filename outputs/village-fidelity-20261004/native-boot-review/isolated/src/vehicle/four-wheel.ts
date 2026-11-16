/**
 * Fachada del vehículo: junta la física (`physics.ts`), la actitud de 4 puntos
 * (`attitude.ts`), el modelo procedural (`model.ts`) y los controles
 * (`controls.ts`). Es lo único que `main.ts` necesita conocer.
 */

import type { Scene } from '@babylonjs/core/scene';
import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh';
import type { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import {
  DEFAULT_VEHICLE_PARAMS,
  clamp,
  createVehicleState,
  stepVehicle,
  type VehicleSurfaceType,
  type VehicleInput,
  type VehicleParams,
  type VehicleState,
  type VehicleSurface,
} from './physics';
import { sampleAttitude, type WheelLayout } from './attitude';
import { createSuspensionState, stepSuspension } from './suspension';
import { createVehicleModel, type VehicleModel } from './model';
import type { VehicleControls } from './controls';
import type { FourWheelDefinition } from './catalog';
import type { VehicleActor, VehicleBodySize, VehiclePose } from './types';

/** Altura en Y de mundo + normal del terreno. `WorldTerrain` la cumple. */
export interface VehicleTerrain extends VehicleSurface {
  heightAt(x: number, z: number): number;
  normalAt(x: number, z: number, out?: unknown): { readonly x: number; readonly y: number; readonly z: number };
}

export interface VehicleTelemetry {
  x: number;
  z: number;
  y: number;
  yawDeg: number;
  speed: number;
  speedKmh: number;
  lateral: number;
  yawRate: number;
  lateralAccel: number;
  distance: number;
  slopeForwardDeg: number;
  slopeRightDeg: number;
  slopeMagnitudeDeg: number;
  pitchDeg: number;
  rollDeg: number;
  slipping: boolean;
  skidding: boolean;
  rolloverRisk: boolean;
  neutral: boolean;
  handbrake: boolean;
  tractionLimitN: number;
  tireForceN: number;
  gravityForceN: number;
  /** Máx |terreno − contacto de rueda| (m) medido tras aplicar la pose. */
  wheelResidualMaxM: number;
  airborne: boolean;
  contacts: readonly number[];
  wheelCompression: readonly number[];
  /** Surface sampled at each contact in FL, FR, RL, RR order. */
  wheelSurfaceTypes: readonly (VehicleSurfaceType | undefined)[];
  suspensionVelocity: number;
}

export interface Vehicle extends VehicleActor {
  readonly category: 'todoterreno' | 'coche';
  readonly bodySize: VehicleBodySize;
  readonly exitOffsetM: number;
  readonly root: TransformNode;
  readonly state: VehicleState;
  readonly params: VehicleParams;
  readonly layout: WheelLayout;
  contactPoints(pose: VehiclePose): readonly { x: number; z: number }[];
  /** Avanza la física. Usa el input manual si se fijó, si no el teclado. */
  step(dt: number): void;
  /** Fija un input manual (tests/capturas). `null` vuelve al teclado. */
  setInput(input: VehicleInput | null): void;
  /** Recoloca el vehículo sobre el terreno en (x, z) con guiñada (rad). */
  teleport(x: number, z: number, yaw: number): void;
  /** Aplica estado físico a los meshes y devuelve el residual de ruedas. */
  applyPose(): number;
  /** Cambia solo la carrocería visible; no altera el estado ni la física. */
  setAppearance(id: 'estandar' | 'patrulla' | 'carga'): void;
  telemetry(): VehicleTelemetry;
  dispose(): void;
}

export interface CreateVehicleOptions {
  scene: Scene;
  terrain: VehicleTerrain;
  spawn: { x: number; z: number; yaw?: number };
  params?: Partial<VehicleParams>;
  controls?: VehicleControls | undefined;
  /** Called when an async visual asset replaces its procedural mesh set. */
  onVisualMeshesReplaced?: (removed: readonly AbstractMesh[], added: readonly AbstractMesh[]) => void;
}

/**
 * Residual vertical de cada rueda: `terreno(x,z) − (centro_rueda.y − radio)`.
 * 0 ⇒ la rueda toca; >0 ⇒ atraviesa; <0 ⇒ flota.
 */
function measureWheelResidual(
  terrain: VehicleTerrain,
  model: VehicleModel,
  wheelRadius: number,
): { maxAbs: number; perWheel: number[] } {
  let maxAbs = 0;
  const perWheel: number[] = [];
  for (const hub of model.wheels) {
    hub.computeWorldMatrix(true);
    const p = hub.getAbsolutePosition();
    const terrainY = terrain.heightAt(p.x, p.z);
    const residual = terrainY - (p.y - wheelRadius);
    perWheel.push(residual);
    if (Math.abs(residual) > maxAbs) maxAbs = Math.abs(residual);
  }
  return { maxAbs, perWheel };
}

const LEGACY_BODY_SIZE: VehicleBodySize = { lengthM: 4.2, widthM: 1.9, heightM: 1.9 };

export function createVehicle(options: CreateVehicleOptions): Vehicle {
  return createFourWheelActor(options);
}

export function createFourWheelVehicle(options: CreateVehicleOptions, definition: FourWheelDefinition): Vehicle {
  return createFourWheelActor(options, definition);
}

function createFourWheelActor(options: CreateVehicleOptions, definition?: FourWheelDefinition): Vehicle {
  const { scene, terrain, spawn } = options;
  const params: VehicleParams = { ...DEFAULT_VEHICLE_PARAMS, ...definition?.params, ...options.params };
  const layout: WheelLayout = {
    front: params.wheelBase / 2,
    rear: params.wheelBase / 2,
    halfTrack: params.track / 2,
  };
  const model = createVehicleModel(scene, layout, params.wheelRadius, 0.32, definition?.visual, definition?.bodySize, options.onVisualMeshesReplaced);
  const state = createVehicleState(spawn.x, spawn.z, spawn.yaw ?? 0);
  const suspensionTravel = 0.24;
  const suspensionTuning = { travel: suspensionTravel };
  const initialSupport = sampleAttitude(terrain, state.x, state.z, state.yaw, layout);
  let suspension = createSuspensionState(initialSupport.contacts, suspensionTuning, initialSupport.pitch, initialSupport.roll);

  let manualInput: VehicleInput | null = null;
  let lastResidual = 0;
  let lastContacts: readonly number[] = [0, 0, 0, 0];

  const applyPose = (): number => {
    const attitude = sampleAttitude(terrain, state.x, state.z, state.yaw, layout);
    model.root.position.set(state.x, suspension.height, state.z);
    model.root.rotation.set(suspension.pitch, state.yaw, suspension.roll);
    model.setWheelPose(state.wheelSpin, state.steer);
    model.setWheelSuspension(suspension.compression, suspensionTravel);
    model.root.computeWorldMatrix(true);
    // The spring target is derived from the terrain-fitted plane, while the
    // chassis attitude is intentionally damped. Correct unsprung wheel travel
    // against the actual, current chassis pose so this lag cannot leave tires
    // suspended above or buried below the terrain during a slope transition.
    const contact = measureWheelResidual(terrain, model, params.wheelRadius);
    const verticalPerTravel = Math.max(0.7, Math.cos(suspension.pitch) * Math.cos(suspension.roll));
    for (let i = 0; i < 4; i++) {
      suspension.compression[i] = clamp(
        suspension.compression[i]! + contact.perWheel[i]! / verticalPerTravel,
        0,
        suspensionTravel,
      );
    }
    model.setWheelSuspension(suspension.compression, suspensionTravel);
    model.root.computeWorldMatrix(true);
    lastContacts = attitude.contacts;
    lastResidual = measureWheelResidual(terrain, model, params.wheelRadius).maxAbs;
    state.airborne = lastResidual > 0.5;
    return lastResidual;
  };

  const telemetry = (): VehicleTelemetry => ({
    x: state.x,
    z: state.z,
    y: model.root.position.y,
    yawDeg: (state.yaw * 180) / Math.PI,
    speed: state.speed,
    speedKmh: state.speed * 3.6,
    lateral: state.lateral,
    yawRate: state.yawRate,
    lateralAccel: state.lateralAccel,
    distance: state.distance,
    slopeForwardDeg: state.slopeForwardDeg,
    slopeRightDeg: state.slopeRightDeg,
    slopeMagnitudeDeg: state.slopeMagnitudeDeg,
    pitchDeg: (model.root.rotation.x * 180) / Math.PI,
    rollDeg: (model.root.rotation.z * 180) / Math.PI,
    slipping: state.slipping,
    skidding: state.skidding,
    rolloverRisk: state.rolloverRisk,
    neutral: state.neutral,
    handbrake: state.handbrake,
    tractionLimitN: state.tractionLimitN,
    tireForceN: state.tireForceN,
    gravityForceN: state.gravityForceN,
    wheelResidualMaxM: lastResidual,
    airborne: state.airborne,
    contacts: lastContacts,
    wheelCompression: [...suspension.compression],
    wheelSurfaceTypes: model.wheels.map((hub) => {
      if (!terrain.surfaceAt) return undefined;
      hub.computeWorldMatrix(true);
      const point = hub.getAbsolutePosition();
      return terrain.surfaceAt(point.x, point.z).type;
    }),
    suspensionVelocity: suspension.verticalVelocity,
  });

  // Pose inicial.
  applyPose();

  return {
    category: definition?.category ?? 'todoterreno',
    bodySize: definition?.bodySize ?? LEGACY_BODY_SIZE,
    exitOffsetM: definition?.exitOffsetM ?? 1.45,
    root: model.root,
    state,
    params,
    layout,
    contactPoints: ({ x, z, yaw }) => {
      const fx = Math.sin(yaw);
      const fz = Math.cos(yaw);
      const rx = Math.cos(yaw);
      const rz = -Math.sin(yaw);
      return [
        [-layout.halfTrack, layout.front], [layout.halfTrack, layout.front],
        [-layout.halfTrack, -layout.rear], [layout.halfTrack, -layout.rear],
      ].map(([side, front]) => ({ x: x + side! * rx + front! * fx, z: z + side! * rz + front! * fz }));
    },
    step: (dt: number) => {
      const input = manualInput ?? options.controls?.read() ?? { throttle: 0, steer: 0, handbrake: false, neutral: false };
      model.setBrakeLights(input.handbrake || (input.throttle < 0 && state.speed > 1));
      const frameDt = clamp(dt, 0, 0.1);
      stepVehicle(state, input, frameDt, params, terrain);
      const support = sampleAttitude(terrain, state.x, state.z, state.yaw, layout);
      stepSuspension(suspension, support.contacts, support.residuals, support.pitch, support.roll, frameDt, suspensionTuning);
      applyPose();
    },
    setInput: (input: VehicleInput | null) => {
      manualInput = input;
    },
    teleport: (x: number, z: number, yaw: number) => {
      state.x = x;
      state.z = z;
      state.yaw = yaw;
      state.speed = 0;
      state.lateral = 0;
      state.steer = 0;
      state.distance = 0;
      const support = sampleAttitude(terrain, x, z, yaw, layout);
      suspension = createSuspensionState(support.contacts, suspensionTuning, support.pitch, support.roll);
      model.setBrakeLights(false);
      applyPose();
    },
    applyPose,
    setAppearance: (id) => {
      if (definition) throw new Error('Cannot change appearance of a catalog vehicle; create a new actor');
      model.setAppearance(id);
    },
    telemetry,
    dispose: () => model.dispose(),
  };
}
