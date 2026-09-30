/** Graphics budgets selected by the runtime and consumed by world/render layers. */
export type GraphicsQualityPresetId = 'LOW' | 'MEDIUM' | 'HIGH' | 'ULTRA';
export type VegetationFamily = 'arbol' | 'arbusto' | 'hierba';
export type VegetationLodRadii = readonly [nearM: number, midM: number, farM: number];

export interface GraphicsQualitySettings {
  readonly id: GraphicsQualityPresetId;
  /** Fraction of the CSS canvas resolution; 1 keeps the native size. */
  readonly renderScale: number;
  readonly shadowMapSize: number;
  readonly shadowRadiusM: number;
  readonly vegetationRadii: Readonly<Record<VegetationFamily, VegetationLodRadii>>;
}

function radii(
  arbol: VegetationLodRadii,
  arbusto: VegetationLodRadii,
  hierba: VegetationLodRadii,
): GraphicsQualitySettings['vegetationRadii'] {
  return Object.freeze({
    arbol: Object.freeze([...arbol]) as unknown as VegetationLodRadii,
    arbusto: Object.freeze([...arbusto]) as unknown as VegetationLodRadii,
    hierba: Object.freeze([...hierba]) as unknown as VegetationLodRadii,
  });
}

/** HIGH is the current shipped baseline; other profiles change only explicit budgets. */
export const GRAPHICS_QUALITY_PRESETS: Readonly<Record<GraphicsQualityPresetId, GraphicsQualitySettings>> = Object.freeze({
  LOW: Object.freeze({
    id: 'LOW', renderScale: 0.75, shadowMapSize: 512, shadowRadiusM: 85,
    vegetationRadii: radii([75, 200, 600], [60, 160, 350], [30, 80, 150]),
  }),
  MEDIUM: Object.freeze({
    id: 'MEDIUM', renderScale: 0.875, shadowMapSize: 768, shadowRadiusM: 92,
    vegetationRadii: radii([90, 260, 750], [72, 200, 420], [38, 100, 185]),
  }),
  HIGH: Object.freeze({
    id: 'HIGH', renderScale: 1, shadowMapSize: 1024, shadowRadiusM: 100,
    vegetationRadii: radii([110, 320, 900], [90, 250, 500], [45, 120, 220]),
  }),
  ULTRA: Object.freeze({
    id: 'ULTRA', renderScale: 1, shadowMapSize: 2048, shadowRadiusM: 125,
    vegetationRadii: radii([110, 320, 900], [90, 250, 500], [45, 120, 220]),
  }),
});

export const DEFAULT_GRAPHICS_QUALITY = GRAPHICS_QUALITY_PRESETS.HIGH;

/** Invalid or missing saved values resolve to the compatible HIGH baseline. */
export function getGraphicsQualityPreset(id: string | null | undefined): GraphicsQualitySettings {
  if (id) {
    const normalized = id.trim().toUpperCase() as GraphicsQualityPresetId;
    if (Object.hasOwn(GRAPHICS_QUALITY_PRESETS, normalized)) return GRAPHICS_QUALITY_PRESETS[normalized];
  }
  return DEFAULT_GRAPHICS_QUALITY;
}
