/** Suspension transients, not an invented collision detector. */
export interface VehicleImpactSample {
  readonly x: number;
  readonly z: number;
  readonly speed: number;
  readonly verticalVelocity: number;
  readonly driving: boolean;
}

/** No timers or audio nodes per update; teleport/reset clears history. */
export function createVehicleImpactDetector() {
  let previous: VehicleImpactSample | null = null;
  let cooldown = 0;
  const reset = () => { previous = null; cooldown = 0; };
  return {
    reset,
    update(next: VehicleImpactSample, dt: number): number {
      if (!Number.isFinite(next.x) || !Number.isFinite(next.z) || !Number.isFinite(next.speed)
        || !Number.isFinite(next.verticalVelocity) || !Number.isFinite(dt) || dt <= 0) {
        reset(); return 0;
      }
      const before = previous;
      previous = next;
      cooldown = Math.max(0, cooldown - Math.min(dt, 0.1));
      if (!before || !next.driving || !before.driving || Math.abs(next.speed) < 1.5 || dt > 0.2) return 0;
      // A teleport/rescue cannot sound like a physical landing.
      if (Math.hypot(next.x - before.x, next.z - before.z) > Math.max(5, Math.abs(next.speed) * dt * 3)) {
        cooldown = 0; return 0;
      }
      const acceleration = Math.abs(next.verticalVelocity - before.verticalVelocity) / Math.max(dt, 1 / 120);
      if (cooldown > 0 || acceleration < 3) return 0;
      cooldown = 0.22;
      return Math.min(1, (acceleration - 3) / 15);
    },
  };
}
