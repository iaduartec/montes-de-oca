import type { RoofShape } from './roof-shape';

/** Evidence-backed runtime corrections; footprints/heights remain sourced from OSM/IGN. */
export interface VillageBuildingOverride {
  readonly roofShape?: RoofShape;
  /** Ridge bearing in world X/Z radians; 0 points along +X and 90° along +Z. */
  readonly ridgeRadians?: number;
  /** Muted artistic multiplier for the shared roof material. */
  readonly roofTint?: readonly [number, number, number];
  readonly roofKind?: 'teja' | 'chapa' | 'pizarra';
  /** Fraction of the computed gable rise added above the normal roof datum. */
  readonly gablePeakRise?: number;
}

export const VILLAGE_BUILDING_OVERRIDES: Readonly<Record<number, VillageBuildingOverride>> = {
  818885706: { roofShape: 'gable', ridgeRadians: Math.PI / 2 },
  818885708: { roofShape: 'hip' },
  474364245: { roofShape: 'hip' },
  474649085: { roofShape: 'gable', ridgeRadians: Math.PI / 2, gablePeakRise: 1 },
  672017718: { roofKind: 'teja', roofTint: [0.92, 0.82, 0.72] },
};

export function selectVillageBuildingOverride(buildingId: number): VillageBuildingOverride | undefined {
  return VILLAGE_BUILDING_OVERRIDES[buildingId];
}
