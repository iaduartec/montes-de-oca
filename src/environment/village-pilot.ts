/**
 * Curated first-pass architecture details for the street visible from spawn.
 * Footprints and heights remain sourced from OSM and the IGN MDSnE at runtime;
 * these profiles are explicitly stylistic reconstruction, not surveyed facades.
 */

export interface VillagePilotHouseStyle {
  /** Add subtle low-poly roof courses to a tile-roof silhouette. */
  readonly tileCourses?: boolean;
  /** Add a pale stone corner return on broad street-facing wall planes. */
  readonly stoneReturns?: boolean;
  /** Ensure a small chimney is present when the measured roof permits it. */
  readonly chimney?: boolean;
}

export const VILLAGE_PILOT_HOUSES: Readonly<Record<number, VillagePilotHouseStyle>> = {
  // First houses to either side of the initial street.
  474364247: { tileCourses: true, stoneReturns: true, chimney: true },
  474364248: { tileCourses: true, chimney: true },
  818885678: { tileCourses: true },
  // Broader footprints down the street, including the southbound view's right edge.
  1509797545: { tileCourses: true, stoneReturns: true },
  1509797544: { tileCourses: true },
  305647007: { tileCourses: true, stoneReturns: true, chimney: true },
  // Calle Mayor 51 and its neighboring three-floor house.
  310458426: { tileCourses: true, chimney: true },
  433198559: { tileCourses: true },
};
