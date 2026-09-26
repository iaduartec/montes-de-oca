export type RoofShape = 'flat' | 'gable' | 'hip' | 'shed';

export interface RoofShapeOptions {
  readonly elongated: boolean;
  readonly hipAllowed: boolean;
  readonly shedAllowed: boolean;
  /** Stable per-building variant; values cycle through 0–3. */
  readonly variant: number;
}

/** Selects a safe, varied roof profile without depending on facade detail LOD. */
export function selectRoofShape(options: RoofShapeOptions): RoofShape {
  if (options.elongated) return 'gable';
  if (options.hipAllowed && options.variant % 4 !== 0) return 'hip';
  if (options.shedAllowed) return 'shed';
  return 'flat';
}
