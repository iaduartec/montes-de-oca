import { DEFAULT_VEHICLE_PARAMS, type VehicleParams } from './physics';

/** Legacy four-wheel presets; the catalog reuses these exact values. */
export type LegacyVehicleVisual = 'estandar' | 'patrulla' | 'carga';

export interface VehiclePreset {
  id: string;
  name: string;
  summary: string;
  visual: LegacyVehicleVisual;
  params: Partial<VehicleParams>;
}

export const VEHICLE_PRESETS: readonly VehiclePreset[] = [
  {
    id: 'estandar',
    name: 'Estándar',
    summary: 'Carrocería rural corta con baca y defensa.',
    visual: 'estandar',
    params: {},
  },
  {
    id: 'patrulla',
    name: 'Patrulla',
    summary: 'Carrocería clara con baliza de servicio.',
    visual: 'patrulla',
    params: {
      mass: 1200,
      dragCoefficient: 0.45,
      maxDriveForce: 18000,
      maxSpeed: 38,
      steerRate: 8,
    },
  },
  {
    id: 'carga',
    name: 'Carga',
    summary: 'Caja trasera abierta con carga visible.',
    visual: 'carga',
    params: {
      mass: 2400,
      dragCoefficient: 0.95,
      brakeForce: 16000,
      maxDriveForce: 10000,
      maxSpeed: 22,
      steerMax: 0.4,
    },
  },
];

export const DEFAULT_PRESET_ID = 'estandar';

export function presetById(id: string): VehiclePreset | undefined {
  return VEHICLE_PRESETS.find((preset) => preset.id === id);
}

/**
 * Aplica un preset sobre `params` (mutado en el lugar). SIEMPRE parte de
 * `DEFAULT_VEHICLE_PARAMS`: aplicar un preset tras otro no deja campos del
 * anterior.
 */
export function applyPreset(params: VehicleParams, preset: VehiclePreset): void {
  Object.assign(params, DEFAULT_VEHICLE_PARAMS, preset.params);
}
