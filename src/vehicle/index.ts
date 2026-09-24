/**
 * Fachada del vehículo: junta la física (`physics.ts`), la actitud de 4 puntos
 * (`attitude.ts`), el modelo procedural (`model.ts`) y los controles
 * (`controls.ts`). Es lo único que `main.ts` necesita conocer.
 */

import type { Scene } from '@babylonjs/core/scene';
import type { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import {
  DEFAULT_VEHICLE_PARAMS,
  clamp,
  createVehicleState,
  stepVehicle,
  type VehicleInput,
  type VehicleParams,
  type VehicleState,
  type VehicleSurface,
} from './physics';
import { sampleAttitude, type WheelLayout } from './attitude';
import { createVehicleModel, type VehicleModel } from './model';
import type { VehicleControls } from './controls';

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
}

export interface Vehicle {
  readonly root: TransformNode;
  readonly state: VehicleState;
  readonly params: VehicleParams;
  readonly layout: WheelLayout;
  /** Avanza la física. Usa el input manual si se fijó, si no el teclado. */
  step(dt: number): void;
  /** Fija un input manual (tests/capturas). `null` vuelve al teclado. */
  setInput(input: VehicleInput | null): void;
  /** Recoloca el vehículo sobre el terreno en (x, z) con guiñada (rad). */
  teleport(x: number, z: number, yaw: number): void;
  /** Aplica estado físico a los meshes y devuelve el residual de ruedas. */
  applyPose(): number;
  telemetry(): VehicleTelemetry;
  dispose(): void;
}

export interface CreateVehicleOptions {
  scene: Scene;
  terrain: VehicleTerrain;
  spawn: { x: number; z: number; yaw?: number };
  params?: Partial<VehicleParams>;
  controls?: VehicleControls | undefined;
}

/**
 * Residual vertical de cada rueda: `terreno(x,z) − (centro_rueda.y − radio)`.
 * 0 ⇒ la rueda toca; >0 ⇒ flota; <0 ⇒ atraviesa.
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

export function createVehicle(options: CreateVehicleOptions): Vehicle {
  const { scene, terrain, spawn } = options;
  const params: VehicleParams = { ...DEFAULT_VEHICLE_PARAMS, ...options.params };
  const layout: WheelLayout = {
    front: params.wheelBase / 2,
    rear: params.wheelBase / 2,
    halfTrack: params.track / 2,
  };
  const model = createVehicleModel(scene, layout, params.wheelRadius);
  const state = createVehicleState(spawn.x, spawn.z, spawn.yaw ?? 0);

  let manualInput: VehicleInput | null = null;
  let lastResidual = 0;
  let lastContacts: readonly number[] = [0, 0, 0, 0];

  const applyPose = (): number => {
    const attitude = sampleAttitude(terrain, state.x, state.z, state.yaw, layout);
    model.root.position.set(state.x, attitude.centerY, state.z);
    model.root.rotation.set(attitude.pitch, state.yaw, attitude.roll);
    model.setWheelPose(state.wheelSpin, state.steer);
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
  });

  // Pose inicial.
  applyPose();

  return {
    root: model.root,
    state,
    params,
    layout,
    step: (dt: number) => {
      const input = manualInput ?? options.controls?.read() ?? { throttle: 0, steer: 0, handbrake: false, neutral: false };
      stepVehicle(state, input, clamp(dt, 0, 0.1), params, terrain);
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
      applyPose();
    },
    applyPose,
    telemetry,
    dispose: () => model.dispose(),
  };
}
