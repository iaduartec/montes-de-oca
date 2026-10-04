import type { RoofShape } from './roof-shape';
import type { CompoundRoofWing } from './village-roof-geometry';

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
  readonly compoundWings?: readonly CompoundRoofWing[];
}

export const VILLAGE_BUILDING_OVERRIDES: Readonly<Record<number, VillageBuildingOverride>> = {
  818885706: { roofShape: 'gable', ridgeRadians: Math.PI / 2 },
  818885708: { roofShape: 'hip' },
  474364245: { roofShape: 'hip' },
  474649085: { roofShape: 'gable', ridgeRadians: Math.PI / 2, gablePeakRise: 1 },
  672017718: {
    roofShape: 'compound',
    roofKind: 'teja',
    roofTint: [0.92, 0.82, 0.72],
    compoundWings: [
      {
        name: 'hospital-west',
        polygon: [
          [2991.43, 3967.54], [2996.96, 3972.29], [2993.68, 3976.19], [2986.22, 3984.88],
          [2977.97, 3977.91], [2966.65, 3968.29], [2985.1, 3946.68], [2989.64, 3950.55],
          [2994.97, 3944.32], [2992.65, 3942.44], [2996.18, 3938.31], [2998.64, 3935.42],
          [2997.74, 3960.07],
        ],
        roofShape: 'hip',
        roofKind: 'teja',
        roofTint: [0.92, 0.82, 0.72],
      },
      {
        name: 'hospital-east',
        polygon: [
          [2998.64, 3935.42], [3005.99, 3941.61], [3012.64, 3937.7], [3013.3, 3937.36],
          [3013.87, 3937.03], [3015.86, 3940.8], [3021.41, 3951.33], [3023.65, 3955.76],
          [3023.98, 3956.31], [3024.07, 3956.42], [3022.18, 3957.54], [3021.76, 3956.76],
          [3015.27, 3960.67], [3008.54, 3964.7], [3003.28, 3967.94], [2999.39, 3961.84],
          [2998.73, 3960.85], [2997.99, 3960.18], [2997.74, 3960.07],
        ],
        roofShape: 'hip',
        roofKind: 'teja',
        roofTint: [0.92, 0.82, 0.72],
        ridgeRadians: 1.087,
        glazingPatch: {
          uMin: -5,
          uMax: 5,
          vMin: -9,
          vMax: -4,
          roofKind: 'chapa',
          roofTint: [0.72, 0.85, 0.96],
        },
      },
    ],
  },
};

export function selectVillageBuildingOverride(buildingId: number): VillageBuildingOverride | undefined {
  return VILLAGE_BUILDING_OVERRIDES[buildingId];
}
