/** Geographic/game coordinates stay logical: east +X, north +Z, height +Y. */
export interface LogicalCoordinates {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** Babylon right-handed render frame: east +X, north -Z, height +Y. */
export interface RenderCoordinates {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

function assertFiniteCoordinates(point: LogicalCoordinates | RenderCoordinates): void {
  if (![point.x, point.y, point.z].every(Number.isFinite)) {
    throw new TypeError('Las coordenadas deben ser números finitos');
  }
}

/** Reflects north-positive logical Z into the render frame without changing scale. */
export function logicalToRender(point: LogicalCoordinates): RenderCoordinates {
  assertFiniteCoordinates(point);
  return { x: point.x, y: point.y, z: -point.z };
}

/** Inverse of `logicalToRender`; simulation and geographic data use this frame. */
export function renderToLogical(point: RenderCoordinates): LogicalCoordinates {
  assertFiniteCoordinates(point);
  return { x: point.x, y: point.y, z: -point.z };
}

/** Reflects a direction/normal; optional normalization is explicit at the call site. */
export function logicalDirectionToRender(
  direction: LogicalCoordinates,
  normalize = false,
): RenderCoordinates {
  const reflected = logicalToRender(direction);
  if (!normalize) return reflected;

  const length = Math.hypot(reflected.x, reflected.y, reflected.z);
  if (length === 0) throw new RangeError('No se puede normalizar una dirección nula');
  return { x: reflected.x / length, y: reflected.y / length, z: reflected.z / length };
}

/**
 * Logical yaw zero points north (+Z). In the render frame that same forward
 * direction is -Z, so the reflected heading is π - yaw.
 */
export function logicalYawToRender(yawRad: number): number {
  if (!Number.isFinite(yawRad)) throw new TypeError('El ángulo lógico debe ser finito');
  return Math.PI - yawRad;
}

/** Inverse of `logicalYawToRender`; angles are intentionally not wrapped. */
export function renderYawToLogical(yawRad: number): number {
  if (!Number.isFinite(yawRad)) throw new TypeError('El ángulo de render debe ser finito');
  return Math.PI - yawRad;
}
