/** Two-contact, terrain-supported motorcycle dynamics; no Babylon dependency. */
import { clamp, GRAVITY, type VehicleInput, type VehicleSurface } from './physics';
import type { MotorcycleParams } from './catalog';
import type { VehiclePose } from './types';
export type { MotorcycleParams } from './catalog';

export interface MotorcycleState extends VehiclePose {
  speed: number;
  lateral: number;
  steer: number;
  yawRate: number;
  leanRad: number;
  fallen: boolean;
  wheelSpin: number;
  distance: number;
  instability: number;
}

export function createMotorcycleState(x: number, z: number, yaw = 0): MotorcycleState {
  return { x, z, yaw, speed: 0, lateral: 0, steer: 0, yawRate: 0, leanRad: 0,
    fallen: false, wheelSpin: 0, distance: 0, instability: 0 };
}

export function motorcycleContacts(pose: VehiclePose, params: MotorcycleParams): { x: number; z: number }[] {
  return [1, -1].map(sign => ({ x: pose.x + Math.sin(pose.yaw) * params.wheelBase * sign / 2,
    z: pose.z + Math.cos(pose.yaw) * params.wheelBase * sign / 2 }));
}

function support(state: VehiclePose, params: MotorcycleParams, surface: VehicleSurface): boolean {
  return motorcycleContacts(state, params).every(point => {
    const n = surface.normalAt(point.x, point.z);
    return Number.isFinite(surface.heightAt(point.x, point.z)) &&
      [n.x, n.y, n.z].every(Number.isFinite) && n.y > Math.cos(params.leanLimitRad);
  });
}

/** Recovery never moves x/z or heading and rejects missing or overly steep ground. */
export function recoverMotorcycle(state: MotorcycleState, params: MotorcycleParams, surface: VehicleSurface): boolean {
  if (!state.fallen || !support(state, params, surface)) return false;
  Object.assign(state, { fallen: false, leanRad: 0, speed: 0, lateral: 0, yawRate: 0, steer: 0, instability: 0 });
  return true;
}

function fall(state: MotorcycleState): void {
  state.fallen = true;
  state.speed = 0;
  state.lateral = 0;
  state.yawRate = 0;
  state.leanRad = (Math.sign(state.leanRad) || 1) * Math.PI / 2;
}

export function stepMotorcycle(state: MotorcycleState, input: VehicleInput, dt: number,
  params: MotorcycleParams, surface: VehicleSurface): void {
  if (!Number.isFinite(dt) || dt <= 0 || state.fallen) return;
  let remaining = Math.min(dt, 0.1);
  while (remaining > 1e-9) {
    const h = Math.min(remaining, 1 / 120);
    remaining -= h;
    if (Math.abs(state.leanRad) > params.fallAngleRad || !support(state, params, surface)) { fall(state); return; }
    const contacts = motorcycleContacts(state, params);
    const front = contacts[0]!; const rear = contacts[1]!;
    const slope = (surface.heightAt(front.x, front.z) - surface.heightAt(rear.x, rear.z)) / params.wheelBase;
    const n = surface.normalAt(state.x, state.z);
    const crossSlope = -(n.x * Math.cos(state.yaw) - n.z * Math.sin(state.yaw)) / Math.max(n.y, 0.001);
    const normalG = GRAVITY * n.y;
    const gripAccel = params.grip * normalG;
    const throttle = clamp(input.throttle, -1, 1);
    const drive = input.neutral ? 0 : throttle * (throttle >= 0 ? params.maxDriveForce * clamp(1 - state.speed / params.maxSpeed, 0, 1) : params.brakeForce);
    const resistance = input.handbrake ? params.brakeForce : (input.neutral ? 0 : 80) + params.mass * normalG * 0.018;
    const gravity = -GRAVITY * slope / Math.hypot(1, slope);
    let acceleration = gravity + clamp(drive / params.mass, -gripAccel, gripAccel) - 0.003 * state.speed * Math.abs(state.speed);
    const braking = Math.min(resistance / params.mass, gripAccel);
    if (Math.abs(state.speed) < 0.05 && Math.abs(acceleration) <= braking) state.speed = 0;
    else {
      const before = state.speed;
      state.speed += (acceleration - Math.sign(state.speed || acceleration) * braking) * h;
      if (before * state.speed < 0 && Math.abs(acceleration) < braking) state.speed = 0;
    }
    state.steer += (clamp(input.steer, -1, 1) * params.steerMax - state.steer) * Math.min(1, h * params.steerRate);
    const requestedYaw = state.speed * Math.tan(state.steer) / params.wheelBase;
    const demand = state.speed * requestedYaw;
    state.yawRate = clamp(requestedYaw, -gripAccel / Math.max(Math.abs(state.speed), 0.1), gripAccel / Math.max(Math.abs(state.speed), 0.1));
    const targetLean = Math.atan2(state.speed * state.yawRate, normalG);
    state.leanRad += (clamp(targetLean, -params.leanLimitRad, params.leanLimitRad) - state.leanRad) * Math.min(1, h * 7);
    // Rider balance handles ordinary turns. Sustained demand beyond tire grip or
    // lean capacity accumulates a loss of balance and produces an actual fall.
    const excess = Math.max(0, Math.abs(demand) / Math.max(gripAccel, 0.1) - 1.15,
      Math.abs(Math.atan(crossSlope) + targetLean) / params.leanLimitRad - 1);
    state.instability = Math.max(0, state.instability + (excess > 0 ? excess : -2) * h);
    if (state.instability > 0.5) { fall(state); return; }
    state.yaw += state.yawRate * h;
    const next = { x: state.x + Math.sin(state.yaw) * state.speed * h,
      z: state.z + Math.cos(state.yaw) * state.speed * h, yaw: state.yaw };
    if (!support(next, params, surface)) { fall(state); return; }
    state.x = next.x; state.z = next.z;
    state.distance += Math.abs(state.speed) * h;
    state.wheelSpin += state.speed / params.wheelRadius * h;
  }
}
