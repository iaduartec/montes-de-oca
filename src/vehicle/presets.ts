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
    name: 'SUV 4x4 utilitario',
    summary: 'Todoterreno genérico de cuatro puertas con carrocería GLB y ruedas dirigibles.',
    visual: 'estandar',
    params: {},
  },
  {
    id: 'patrulla',
    name: 'Todoterreno de servicio',
    summary: '4x4 genérico de cinco puertas para rutas rurales; modelo visual de referencia, no una reproducción de marca.',
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
    name: 'Jeep Wrangler TJ',
    summary: 'Wrangler TJ 2 puertas: frontal vertical, parrilla de 7 ranuras y repuesto exterior.',
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
