import type { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import type { VehicleInput } from './physics';

export type VehicleCategory = 'todoterreno' | 'coche' | 'moto';

export interface VehiclePose {
  x: number;
  z: number;
  yaw: number;
}

export interface VehicleBodySize {
  lengthM: number;
  widthM: number;
  heightM: number;
}

/** Fields that every active vehicle exposes to the game coordinator. */
export interface VehicleActor {
  readonly category: VehicleCategory;
  readonly root: TransformNode;
  readonly state: VehiclePose & { speed: number; lateral: number };
  readonly bodySize: VehicleBodySize;
  readonly exitOffsetM: number;
  contactPoints(pose: VehiclePose): readonly { x: number; z: number }[];
  step(dt: number): void;
  setInput(input: VehicleInput | null): void;
  teleport(x: number, z: number, yaw: number): void;
  applyPose(): number;
  telemetry(): VehicleActorTelemetry;
  dispose(): void;
}

export interface VehicleActorTelemetry {
  x: number;
  z: number;
  y: number;
  yawDeg: number;
  speed: number;
  speedKmh: number;
  lateral: number;
}
