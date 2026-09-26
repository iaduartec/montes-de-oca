/** Radial scale for a lobed low-poly plant profile. */
export function radialLobeScale(t: number, angle: number, amount: number, count: number): number {
  return 1 + amount * Math.cos(angle * count) * Math.sin(Math.PI * t);
}

/** Angular silhouette variation for open-ended frusta such as juniper shrubs. */
export function radialLobeScaleAtAngle(angle: number, amount: number, count: number): number {
  return 1 + amount * Math.cos(angle * count);
}

/** Stable, restrained per-instance multiplier that keeps the existing species palette. */
export function vegetationInstanceTint(x: number, z: number): readonly [number, number, number] {
  let hash = (Math.imul(Math.round(x * 10), 73856093) ^ Math.imul(Math.round(z * 10), 19349663)) >>> 0;
  hash = Math.imul(hash ^ (hash >>> 16), 0x85ebca6b) >>> 0;
  hash = Math.imul(hash ^ (hash >>> 13), 0xc2b2ae35) >>> 0;
  hash = (hash ^ (hash >>> 16)) >>> 0;

  const brightness = 0.94 + ((hash & 0xffff) / 0xffff) * 0.12;
  const red = 0.99 + (((hash >>> 16) & 0xff) / 0xff) * 0.02;
  const blue = 0.99 + (((hash >>> 24) & 0xff) / 0xff) * 0.02;
  return [brightness * red, brightness, brightness * blue];
}
