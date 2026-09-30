export interface VillageNpcSpawn {
  readonly name: string;
  readonly x: number;
  readonly z: number;
  readonly yaw: number;
}

// Clear roadside points beside La Plaza. The points sit outside nearby building
// footprints and road edges in the checked-in roads/buildings datasets.
export const VILLAGE_NPC_SPAWNS: readonly VillageNpcSpawn[] = [
  { name: 'vecino-01', x: 3063.612, z: 4007.209, yaw: 0.99 },
  { name: 'vecino-02', x: 3055.746, z: 4002.003, yaw: 0.99 },
];
