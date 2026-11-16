import type { RoadClass, RoadTerrain } from './road-draping';

export interface RoadProfileStation {
  chainage: number;
  centerHeight: number;
  longitudinalSlope: number;
  desiredBank: number;
  widthLeft: number;
  widthRight: number;
}
/** caef87e unfiltered geometry p95 bank: .259/.356/.447. These are design
 * bounds, not surveyed cambers. Preserve low crossfalls and reduce the full
 * distribution with class-specific compression before bounding its tail. */
export const ROAD_PROFILE_POLICY = {
  ROAD: { bank: .08, retain: .35, radiusM: 12, maxFillM: .6 },
  TRACK: { bank: .20, retain: .65, radiusM: 6, maxFillM: .3 },
  PATH: { bank: .35, retain: .85, radiusM: 3, maxFillM: .12 },
} as const;

export function buildRoadProfile(
  stations: readonly { x: number; z: number; t: number }[],
  widths: readonly { pavementLeft: number; pavementRight: number }[],
  terrain: RoadTerrain,
  cls: RoadClass,
): RoadProfileStation[] {
  const policy = ROAD_PROFILE_POLICY[cls];
  const directions = stations.map((_, i) => {
    const a = stations[Math.max(0, i - 1)]!, b = stations[Math.min(stations.length - 1, i + 1)]!;
    const length = Math.hypot(b.x - a.x, b.z - a.z) || 1;
    return { nx: -(b.z - a.z) / length, nz: (b.x - a.x) / length };
  });
  const banks = stations.map((s, i) => {
    const d = directions[i]!, w = widths[i]!, span = w.pavementLeft + w.pavementRight;
    const raw = span > .01 ? (terrain.heightAt(s.x + d.nx * w.pavementLeft, s.z + d.nz * w.pavementLeft) - terrain.heightAt(s.x - d.nx * w.pavementRight, s.z - d.nz * w.pavementRight)) / span : 0;
    return Math.max(-policy.bank, Math.min(policy.bank, raw * policy.retain));
  });
  const smoothBank = stations.map((s, i) => {
    let sum = 0, weight = 0;
    for (let j = Math.max(0, i - 16); j <= Math.min(stations.length - 1, i + 16); j++) {
      const k = Math.max(0, 1 - Math.abs(stations[j]!.t - s.t) / policy.radiusM);
      sum += banks[j]! * k; weight += k;
    }
    return weight ? sum / weight : banks[i]!;
  });
  const support = stations.map(s => terrain.heightAt(s.x, s.z));
  const distances = stations.map(s => s.t);
  // Local linear regression preserves a mountain grade while smoothing vertical
  // jerk in both directions. Cuts/fills are limited and joined by the skirts;
  // the renderer excises only the covered MDT footprint, not the landscape.
  let heights = support.map((raw, i) => {
    let sw = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (let j = Math.max(0, i - 32); j <= Math.min(stations.length - 1, i + 32); j++) {
      const x = distances[j]! - distances[i]!, w = Math.max(0, 1 - Math.abs(x) / policy.radiusM);
      sw += w; sx += w * x; sy += w * support[j]!; sxx += w * x * x; sxy += w * x * support[j]!;
    }
    const det = sw * sxx - sx * sx;
    const target = det > 1e-8 ? (sy * sxx - sx * sxy) / det : raw;
    const edge = Math.min(distances[i]! - distances[0]!, distances.at(-1)! - distances[i]!);
    const t = Math.min(1, edge / policy.radiusM), fade = t * t * (3 - 2 * t);
    return raw + Math.max(-policy.maxFillM, Math.min(policy.maxFillM, target - raw)) * fade;
  });
  const iterations = cls === 'ROAD' ? 24 : cls === 'TRACK' ? 12 : 3;
  for (let pass = 0; pass < iterations; pass++) {
    heights = heights.map((y, i) => {
      if (i === 0 || i === heights.length - 1) return y;
      const left = distances[i]! - distances[i - 1]!, right = distances[i + 1]! - distances[i]!;
      const linear = (heights[i - 1]! * right + heights[i + 1]! * left) / (left + right);
      return Math.max(support[i]! - policy.maxFillM, Math.min(support[i]! + policy.maxFillM, y * .35 + linear * .65));
    });
  }
  return stations.map((s, i) => {
    const a = Math.max(0, i - 1), b = Math.min(stations.length - 1, i + 1);
    return { chainage: s.t, centerHeight: heights[i]!, desiredBank: smoothBank[i]!, longitudinalSlope: (heights[b]! - heights[a]!) / (distances[b]! - distances[a]! || 1), widthLeft: widths[i]!.pavementLeft, widthRight: widths[i]!.pavementRight };
  });
}
