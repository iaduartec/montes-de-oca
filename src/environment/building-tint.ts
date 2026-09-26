export type BuildingTint = readonly [number, number, number];

/** Small deterministic RGB multipliers that keep every wall in its material palette. */
export function buildingTint(id: number): BuildingTint {
  let hash = (id ^ 0x9e3779b9) >>> 0;
  hash = Math.imul(hash ^ (hash >>> 16), 0x85ebca6b) >>> 0;
  hash = Math.imul(hash ^ (hash >>> 13), 0xc2b2ae35) >>> 0;
  hash = (hash ^ (hash >>> 16)) >>> 0;

  const brightness = 0.95 + ((hash & 0xffff) / 0xffff) * 0.1;
  const warm = 0.985 + (((hash >>> 16) & 0xff) / 0xff) * 0.03;
  const cool = 0.985 + (((hash >>> 24) & 0xff) / 0xff) * 0.03;
  return [brightness * warm, brightness, brightness * cool];
}

/** A wider, warm roof palette keeps clay tile varied without changing materials. */
export function buildingRoofTint(id: number): BuildingTint {
  let hash = (id ^ 0x85ebca6b) >>> 0;
  hash = Math.imul(hash ^ (hash >>> 16), 0xc2b2ae35) >>> 0;
  hash = Math.imul(hash ^ (hash >>> 13), 0x27d4eb2f) >>> 0;
  hash = (hash ^ (hash >>> 16)) >>> 0;

  const brightness = 0.88 + ((hash & 0xffff) / 0xffff) * 0.24;
  const red = 0.98 + (((hash >>> 16) & 0xff) / 0xff) * 0.05;
  const blue = 0.93 + (((hash >>> 24) & 0xff) / 0xff) * 0.05;
  return [brightness * red, brightness, brightness * blue];
}
