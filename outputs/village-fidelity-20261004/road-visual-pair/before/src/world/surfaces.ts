/** Shared tuning, not a geological map. Unknown off-road ground uses GRASS. */
export type SurfaceType = 'ROAD' | 'TRACK' | 'PATH' | 'GRASS' | 'MUD' | 'ROCK';
export interface SurfaceDefinition {
  readonly type: SurfaceType;
  /** Multipliers applied to the selected vehicle's tuning. */
  readonly grip: number;
  readonly lateralGrip: number;
  readonly brakingGrip: number;
  readonly rollingResistance: number;
  readonly suspensionNoise: number;
  readonly dust: number;
  readonly roughness: number;
  readonly wheelAudio: number;
  readonly skidAudio: number;
}
function definition(type: SurfaceType, grip: number, lateralGrip: number, brakingGrip: number,
  rollingResistance: number, roughness: number, dust: number): SurfaceDefinition {
  return Object.freeze({ type, grip, lateralGrip, brakingGrip, rollingResistance,
    roughness, dust, suspensionNoise: roughness, wheelAudio: roughness, skidAudio: 1 - lateralGrip * 0.5 });
}
export const SURFACES: Readonly<Record<SurfaceType, SurfaceDefinition>> = Object.freeze({
  ROAD: definition('ROAD', 1, 1, 1, 0.65, 0.08, 0),
  TRACK: definition('TRACK', 0.8, 0.8, 0.8, 1.3, 0.65, 0.8),
  PATH: definition('PATH', 0.72, 0.68, 0.72, 1.6, 0.8, 0.65),
  GRASS: definition('GRASS', 0.6, 0.55, 0.6, 2, 0.45, 0.15),
  MUD: definition('MUD', 0.4, 0.35, 0.42, 3.5, 0.7, 0),
  ROCK: definition('ROCK', 0.75, 0.7, 0.7, 1.5, 1, 0.3),
});

export interface SurfaceRoad {
  readonly class: 'ROAD' | 'TRACK' | 'PATH';
  readonly width: number;
  readonly points: readonly (readonly [number, number])[];
  readonly clearance?: {
    readonly stepM: number;
    readonly bandLeft: readonly number[];
    readonly bandRight: readonly number[];
  } | null;
}
interface Segment {
  readonly road: SurfaceRoad;
  readonly ax: number; readonly az: number; readonly bx: number; readonly bz: number;
  readonly startM: number; readonly length: number;
}
const CELL_M = 32;
function band(values: readonly number[], step: number, distance: number): number {
  const p = Math.min(values.length - 1, Math.max(0, distance / step));
  const i = Math.floor(p);
  return values[i]! + ((values[Math.min(i + 1, values.length - 1)]! - values[i]!) * (p - i));
}

/** Index the existing polylines once; no network lookup or scene picking per wheel. */
export function createSurfaceResolver(roads: readonly SurfaceRoad[],
  offRoadAt: (x: number, z: number) => SurfaceType = () => 'GRASS',
): (x: number, z: number) => SurfaceDefinition {
  const cells = new Map<string, Segment[]>();
  for (const road of roads) {
    let distance = 0;
    for (let i = 1; i < road.points.length; i++) {
      const [ax, az] = road.points[i - 1]!;
      const [bx, bz] = road.points[i]!;
      const length = Math.hypot(bx - ax, bz - az);
      if (length === 0) continue;
      const segment: Segment = { road, ax, az, bx, bz, startM: distance, length };
      distance += length;
      const radius = road.width / 2;
      for (let x = Math.floor((Math.min(ax, bx) - radius) / CELL_M); x <= Math.floor((Math.max(ax, bx) + radius) / CELL_M); x++) {
        for (let z = Math.floor((Math.min(az, bz) - radius) / CELL_M); z <= Math.floor((Math.max(az, bz) + radius) / CELL_M); z++) {
          const key = `${x},${z}`;
          const bucket = cells.get(key);
          if (bucket) bucket.push(segment); else cells.set(key, [segment]);
        }
      }
    }
  }
  return (x, z) => {
    const candidates = cells.get(`${Math.floor(x / CELL_M)},${Math.floor(z / CELL_M)}`) ?? [];
    let nearest = Infinity;
    let result: SurfaceType | null = null;
    for (const s of candidates) {
      const dx = s.bx - s.ax, dz = s.bz - s.az;
      const t = Math.max(0, Math.min(1, ((x - s.ax) * dx + (z - s.az) * dz) / (s.length * s.length)));
      const ex = x - s.ax - t * dx, ez = z - s.az - t * dz;
      const distance = Math.hypot(ex, ez);
      // Same local left/right convention as the renderer: left = (-dz, dx).
      const left = ex * -dz + ez * dx >= 0;
      const profile = s.road.clearance;
      const width = profile ? Math.min(s.road.width / 2, band(left ? profile.bandLeft : profile.bandRight,
        profile.stepM, s.startM + t * s.length)) : s.road.width / 2;
      if (distance <= width && distance < nearest) { nearest = distance; result = s.road.class; }
    }
    return SURFACES[result ?? offRoadAt(x, z)];
  };
}
