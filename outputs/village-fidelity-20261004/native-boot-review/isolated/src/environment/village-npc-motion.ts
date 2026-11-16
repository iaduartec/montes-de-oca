import type { VillageNpcWalkRoute } from './village-npc-navigation';

export type VillageNpcMotionMode = 'IDLE' | 'WALK';

export interface VillageNpcMotionState {
  readonly route: VillageNpcWalkRoute;
  readonly speedMps: number;
  readonly idleDurationS: number;
  readonly phaseS: number;
  elapsedS: number;
  mode: VillageNpcMotionMode;
  distanceM: number;
  direction: 1 | -1;
}

function hash(text: string): number {
  let value = 2166136261;
  for (let i = 0; i < text.length; i += 1) value = Math.imul(value ^ text.charCodeAt(i), 16777619);
  return value >>> 0;
}

/** Stable variation without runtime randomness, so routes replay identically. */
export function createVillageNpcMotion(route: VillageNpcWalkRoute): VillageNpcMotionState {
  const seed = hash(route.id);
  return {
    route,
    speedMps: 0.72 + ((seed >>> 4) % 42) / 100,
    idleDurationS: 2.5 + ((seed >>> 11) % 50) / 10,
    phaseS: ((seed >>> 18) % 1000) / 1000 * 12,
    elapsedS: 0,
    mode: 'IDLE',
    distanceM: route.lengthM / 2,
    direction: 1,
  };
}

export interface VillageNpcMotionStep {
  readonly changed: boolean;
  readonly mode: VillageNpcMotionMode;
  readonly x: number;
  readonly z: number;
  readonly yaw: number;
}

/** Root-motion-free shuttle along a checked route; pause at each endpoint. */
export function stepVillageNpcMotion(state: VillageNpcMotionState, dt: number): VillageNpcMotionStep {
  const previousMode = state.mode;
  const safeDt = Number.isFinite(dt) ? Math.min(0.1, Math.max(0, dt)) : 0;
  state.elapsedS += safeDt;
  const [start, end] = state.route.points;
  if (state.mode === 'IDLE') {
    const cycleIdle = state.idleDurationS;
    if ((state.elapsedS + state.phaseS) % (cycleIdle + 4 / state.speedMps) >= cycleIdle) state.mode = 'WALK';
  }
  if (state.mode === 'WALK') {
    state.distanceM += safeDt * state.speedMps * state.direction;
    if (state.distanceM >= state.route.lengthM) {
      state.distanceM = state.route.lengthM;
      state.direction = -1;
      state.mode = 'IDLE';
    } else if (state.distanceM <= 0) {
      state.distanceM = 0;
      state.direction = 1;
      state.mode = 'IDLE';
    }
  }
  const t = state.distanceM / state.route.lengthM;
  const x = start.x + (end.x - start.x) * t;
  const z = start.z + (end.z - start.z) * t;
  const yaw = Math.atan2((end.x - start.x) * state.direction, (end.z - start.z) * state.direction);
  return { changed: previousMode !== state.mode, mode: state.mode, x, z, yaw };
}
