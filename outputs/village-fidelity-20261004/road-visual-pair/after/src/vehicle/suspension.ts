import { clamp } from './physics';

/** Four point, terrain sampled spring support for the visual chassis and wheels. */
export interface SuspensionState {
  /** World Y of the body root. */
  height: number;
  verticalVelocity: number;
  pitch: number;
  roll: number;
  pitchVelocity: number;
  rollVelocity: number;
  /** Spring travel used at each contact, ordered FL, FR, RL, RR. */
  readonly compression: [number, number, number, number];
}

export interface SuspensionTuning {
  readonly travel: number;
  /** Spring natural frequency in Hz. */
  readonly frequencyHz?: number;
  readonly dampingRatio?: number;
}

const DEFAULT_FREQUENCY_HZ = 2.4;
const DEFAULT_DAMPING_RATIO = 1.05;
const ATTITUDE_FREQUENCY_HZ = 6;

export function createSuspensionState(
  groundContacts: readonly number[], tuning: SuspensionTuning, pitch = 0, roll = 0,
): SuspensionState {
  if (groundContacts.length !== 4 || groundContacts.some((height) => !Number.isFinite(height))) {
    throw new RangeError('Suspension requires four finite ground contacts');
  }
  const restHeight = mean(groundContacts) + tuning.travel / 2;
  return {
    height: restHeight,
    verticalVelocity: 0,
    pitch,
    roll,
    pitchVelocity: 0,
    rollVelocity: 0,
    compression: [tuning.travel / 2, tuning.travel / 2, tuning.travel / 2, tuning.travel / 2],
  };
}

/** Advance damped body support and derive independent wheel travel from four contacts. */
export function stepSuspension(
  state: SuspensionState,
  groundContacts: readonly number[],
  planeResiduals: readonly number[],
  targetPitch: number,
  targetRoll: number,
  dt: number,
  tuning: SuspensionTuning,
): void {
  if (groundContacts.length !== 4 || planeResiduals.length !== 4 ||
    groundContacts.some((height) => !Number.isFinite(height)) || planeResiduals.some((height) => !Number.isFinite(height)) ||
    !Number.isFinite(targetPitch) || !Number.isFinite(targetRoll) || !Number.isFinite(dt) || dt <= 0) return;

  const travel = Math.max(0, tuning.travel);
  const meanGround = mean(groundContacts);
  const targetHeight = meanGround + travel / 2;
  const omega = 2 * Math.PI * (tuning.frequencyHz ?? DEFAULT_FREQUENCY_HZ);
  const damping = Math.max(0, tuning.dampingRatio ?? DEFAULT_DAMPING_RATIO);
  const attitudeOmega = 2 * Math.PI * ATTITUDE_FREQUENCY_HZ;

  // Stable semi-implicit integration across ordinary frame times and hitches.
  let remaining = Math.min(dt, 0.1);
  while (remaining > 1e-9) {
    const h = Math.min(remaining, 1 / 120);
    const acceleration = omega * omega * (targetHeight - state.height) - 2 * damping * omega * state.verticalVelocity;
    state.verticalVelocity += acceleration * h;
    state.height += state.verticalVelocity * h;
    state.pitchVelocity += (attitudeOmega * attitudeOmega * (targetPitch - state.pitch) - 2 * state.pitchVelocity * attitudeOmega) * h;
    state.pitch += state.pitchVelocity * h;
    state.rollVelocity += (attitudeOmega * attitudeOmega * (targetRoll - state.roll) - 2 * state.rollVelocity * attitudeOmega) * h;
    state.roll += state.rollVelocity * h;
    remaining -= h;
  }

  const bodyOffset = targetHeight - state.height;
  for (let i = 0; i < 4; i++) {
    state.compression[i] = clamp(travel / 2 + planeResiduals[i]! + bodyOffset, 0, travel);
  }
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
