import type { CreateVehicleOptions } from './four-wheel';
import type { MotorcycleDefinition } from './catalog';
import type { VehicleActor, VehicleActorTelemetry } from './types';
import type { VehicleInput } from './physics';
import { createMotorcycleState, motorcycleContacts, recoverMotorcycle, stepMotorcycle, type MotorcycleState } from './motorcycle-physics';
import { createMotorcycleModel } from './motorcycle-model';
import type { TransformNode } from '@babylonjs/core/Meshes/transformNode';

export interface MotorcycleTelemetry extends VehicleActorTelemetry {
  contacts: readonly number[];
  leanRad: number;
  fallen: boolean;
  yawRate: number;
  wheelResidualMaxM: number;
}
export interface Motorcycle extends VehicleActor {
  readonly category: 'moto';
  readonly state: MotorcycleState;
  readonly riderSeat: TransformNode;
  readonly riderHands: TransformNode;
  readonly riderFeet: TransformNode;
  readonly cameraTarget: TransformNode;
  recover(): boolean;
  telemetry(): MotorcycleTelemetry;
}

export function createMotorcycle(options: CreateVehicleOptions, definition: MotorcycleDefinition): Motorcycle {
  const { scene, terrain, spawn } = options;
  const params = definition.params;
  const model = createMotorcycleModel(scene, definition);
  const state = createMotorcycleState(spawn.x, spawn.z, spawn.yaw ?? 0);
  let input: VehicleInput | null = null;
  let contacts = [0, 0];
  let residual = 0;
  const applyPose = (): number => {
    const points = motorcycleContacts(state, params);
    contacts = points.map(point => terrain.heightAt(point.x, point.z));
    const centerY = (contacts[0]! + contacts[1]!) / 2;
    const pitch = -Math.atan2(contacts[0]! - contacts[1]!, params.wheelBase);
    model.root.position.set(state.x, centerY, state.z); model.root.rotation.y = state.yaw;
    model.frame.rotation.set(pitch, 0, -state.leanRad);
    // Lean pivots at the tire support line, keeping the frame and rider tied to
    // physical balance. Wheel centers retain their two terrain sample heights.
    model.frame.position.y = state.fallen ? 0.16 : 0;
    model.handlebar.rotation.y = state.steer;
    residual = 0;
    model.wheels.forEach(({ hub, spin }, index) => {
      const verticalRadius = params.wheelRadius * Math.abs(Math.cos(state.leanRad));
      hub.position.y = contacts[index]! - centerY + Math.max(0.07, verticalRadius);
      hub.rotation.set(0, index === 0 ? state.steer : 0, -state.leanRad);
      spin.rotation.x = state.wheelSpin;
      hub.computeWorldMatrix(true);
      residual = Math.max(residual, Math.abs(terrain.heightAt(points[index]!.x, points[index]!.z) - (hub.getAbsolutePosition().y - Math.max(0.07, verticalRadius))));
    });
    return residual;
  };
  applyPose();
  return {
    category: 'moto', root: model.root, state, bodySize: definition.bodySize, exitOffsetM: definition.exitOffsetM,
    riderSeat: model.riderSeat, riderHands: model.riderHands, riderFeet: model.riderFeet, cameraTarget: model.cameraTarget,
    contactPoints: pose => motorcycleContacts(pose, params),
    step: dt => { stepMotorcycle(state, input ?? options.controls?.read() ?? { throttle: 0, steer: 0, handbrake: false, neutral: false }, dt, params, terrain); applyPose(); },
    setInput: value => { input = value; },
    teleport: (x, z, yaw) => { Object.assign(state, createMotorcycleState(x, z, yaw)); applyPose(); },
    recover: () => { const recovered = recoverMotorcycle(state, params, terrain); if (recovered) applyPose(); return recovered; },
    applyPose,
    telemetry: () => ({ x: state.x, z: state.z, y: model.root.position.y, yawDeg: state.yaw * 180 / Math.PI,
      speed: state.speed, speedKmh: state.speed * 3.6, lateral: state.lateral, contacts,
      leanRad: state.leanRad, fallen: state.fallen, yawRate: state.yawRate, wheelResidualMaxM: residual }),
    dispose: model.dispose,
  };
}
