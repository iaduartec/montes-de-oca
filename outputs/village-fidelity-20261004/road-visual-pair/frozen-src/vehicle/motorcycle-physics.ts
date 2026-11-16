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
  leanVelocity: number;
  recovering: boolean;
  fallen: boolean;
  wheelSpin: number;
  distance: number;
  instability: number;
}

export function createMotorcycleState(x: number, z: number, yaw = 0): MotorcycleState {
  return { x, z, yaw, speed: 0, lateral: 0, steer: 0, yawRate: 0, leanRad: 0,
    fallen: false, leanVelocity: 0, recovering: false, wheelSpin: 0, distance: 0, instability: 0 };
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
  Object.assign(state, { fallen: false, recovering: true, speed: 0, lateral: 0, yawRate: 0, steer: 0, instability: 0 });
  return true;
}

function fall(state: MotorcycleState): void {
  state.fallen = true;
  state.speed = 0;
  state.lateral = 0;
  state.yawRate = 0;
  state.recovering = false;
}

/** Exact critically damped spring: angular velocity stays continuous across targets.
 * Its response follows the existing steering actuator rate rather than a frame gain.
 */
function balance(state: MotorcycleState, target: number, rate: number, dt: number): void {
  const displacement = state.leanRad - target;
  const velocity = state.leanVelocity;
  const decay = Math.exp(-rate * dt);
  const c = velocity + rate * displacement;
  state.leanRad = target + (displacement + c * dt) * decay;
  state.leanVelocity = (velocity - rate * c * dt) * decay;
}

export function stepMotorcycle(state: MotorcycleState, input: VehicleInput, dt: number,
  params: MotorcycleParams, surface: VehicleSurface): void {
  if (!Number.isFinite(dt) || dt <= 0) return;
  let remaining = Math.min(dt, 0.1);
  while (remaining > 1e-9) {
    const h = Math.min(remaining, 1 / 120);
    remaining -= h;
    if (state.fallen) {
      balance(state, (Math.sign(state.leanRad) || 1) * Math.PI / 2, params.steerRate, h);
      continue;
    }
    if (state.recovering) {
      if (!support(state, params, surface)) { fall(state); return; }
      balance(state, 0, params.steerRate * 2, h);
      // A recovery is settled below one tenth degree, including angular motion.
      if (Math.abs(state.leanRad) < Math.PI / 1800 && Math.abs(state.leanVelocity) < Math.PI / 1800) state.recovering = false;
      continue;
    }
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
    // Convert input to curvature within tire and rider capacity BEFORE asking
    // for yaw. Previously the unclamped geometric demand alone triggered a fall,
    // even while the executed yaw was safely clamped by grip.
    const bankAngle = Math.atan(crossSlope);
    const availableLean = Math.max(0, params.leanLimitRad - Math.abs(bankAngle));
    const turnAccel = Math.min(gripAccel, normalG * Math.tan(availableLean));
    const steerLimit = Math.min(params.steerMax, Math.atan2(turnAccel * params.wheelBase, state.speed * state.speed));
    const requestedSteer = clamp(clamp(input.steer, -1, 1) * params.steerMax, -steerLimit, steerLimit);
    state.steer += (requestedSteer - state.steer) * (1 - Math.exp(-h * params.steerRate));
    const requestedYaw = state.speed * Math.tan(state.steer) / params.wheelBase;
    state.yawRate = clamp(requestedYaw, -turnAccel / Math.max(Math.abs(state.speed), 0.1), turnAccel / Math.max(Math.abs(state.speed), 0.1));
    const targetLean = Math.atan2(state.speed * state.yawRate, normalG);
    // At walking speed lateral acceleration tends to zero and assistance grows;
    // curves still lean naturally, while release/braking returns upright smoothly.
    const uprightAssist = 1 + 1 / (1 + Math.abs(state.speed));
    balance(state, clamp(targetLean, -availableLean, availableLean), params.steerRate * 2 * uprightAssist, h);
    state.instability = 0;
    state.yaw += state.yawRate * h;
    const next = { x: state.x + Math.sin(state.yaw) * state.speed * h,
      z: state.z + Math.cos(state.yaw) * state.speed * h, yaw: state.yaw };
    if (!support(next, params, surface)) { fall(state); return; }
    state.x = next.x; state.z = next.z;
    state.distance += Math.abs(state.speed) * h;
    state.wheelSpin += state.speed / params.wheelRadius * h;
  }
}
