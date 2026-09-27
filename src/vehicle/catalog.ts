import type { VehicleParams } from './physics';
import { VEHICLE_PRESETS, type LegacyVehicleVisual, type VehiclePreset } from './presets';
import type { VehicleBodySize, VehicleCategory } from './types';

export type { VehicleCategory } from './types';

interface DefinitionBase {
  readonly id: string;
  readonly name: string;
  readonly summary: string;
  readonly visual: string;
  readonly bodySize: VehicleBodySize;
  readonly exitOffsetM: number;
}

export interface FourWheelDefinition extends DefinitionBase {
  readonly category: Exclude<VehicleCategory, 'moto'>;
  readonly params: Partial<VehicleParams>;
  readonly visual: VehiclePreset['visual'] | 'explorador' | 'turismo' | 'rally';
}

/** Physics values for the future two-contact motorcycle actor. */
export interface MotorcycleParams {
  readonly mass: number;
  readonly wheelBase: number;
  readonly wheelRadius: number;
  readonly maxDriveForce: number;
  readonly maxSpeed: number;
  readonly brakeForce: number;
  readonly steerMax: number;
  readonly steerRate: number;
  readonly grip: number;
  readonly leanLimitRad: number;
  readonly fallAngleRad: number;
}

export interface MotorcycleDefinition extends DefinitionBase {
  readonly category: 'moto';
  readonly visual: 'trail' | 'enduro';
  readonly params: MotorcycleParams;
}

export type VehicleDefinition = FourWheelDefinition | MotorcycleDefinition;

function legacy(id: LegacyVehicleVisual, bodySize: VehicleBodySize, exitOffsetM: number): FourWheelDefinition {
  const preset = VEHICLE_PRESETS.find((entry) => entry.id === id);
  if (!preset) throw new Error(`Missing legacy vehicle preset: ${id}`);
  return { ...preset, category: 'todoterreno', bodySize, exitOffsetM };
}

export const VEHICLE_CATALOG: readonly VehicleDefinition[] = [
  legacy('estandar', { lengthM: 4.2, widthM: 1.9, heightM: 1.9 }, 1.45),
  legacy('patrulla', { lengthM: 4.4, widthM: 1.9, heightM: 1.95 }, 1.45),
  legacy('carga', { lengthM: 4.8, widthM: 2.05, heightM: 2.05 }, 1.55),
  {
    id: 'explorador', category: 'todoterreno', name: 'Explorador',
    summary: 'Todoterreno ligero de batalla corta para caminos estrechos.', visual: 'explorador',
    bodySize: { lengthM: 3.9, widthM: 1.8, heightM: 1.85 }, exitOffsetM: 1.4,
    params: { mass: 1550, wheelBase: 2.5, track: 1.54, maxDriveForce: 15500, maxSpeed: 30, grip: 0.88 },
  },
  {
    id: 'turismo', category: 'coche', name: 'Turismo',
    summary: 'Coche de carretera estable y rápido sobre asfalto.', visual: 'turismo',
    bodySize: { lengthM: 4.5, widthM: 1.82, heightM: 1.48 }, exitOffsetM: 1.35,
    params: { mass: 1350, wheelBase: 2.68, track: 1.55, cgHeight: 0.55, wheelRadius: 0.33,
      maxDriveForce: 11500, maxSpeed: 42, dragCoefficient: 0.42, grip: 0.86 },
  },
  {
    id: 'rally', category: 'coche', name: 'Rally',
    summary: 'Coche ágil preparado para pistas de tierra.', visual: 'rally',
    bodySize: { lengthM: 4.15, widthM: 1.84, heightM: 1.5 }, exitOffsetM: 1.38,
    params: { mass: 1250, wheelBase: 2.55, track: 1.58, cgHeight: 0.56, wheelRadius: 0.34,
      maxDriveForce: 16500, maxSpeed: 40, steerRate: 8, grip: 0.91, gripLateral: 0.88 },
  },
  {
    id: 'trail', category: 'moto', name: 'Trail',
    summary: 'Moto polivalente de suspensión alta para rutas mixtas.', visual: 'trail',
    bodySize: { lengthM: 2.2, widthM: 0.85, heightM: 1.4 }, exitOffsetM: 0.95,
    params: { mass: 240, wheelBase: 1.5, wheelRadius: 0.34, maxDriveForce: 2100,
      maxSpeed: 35, brakeForce: 2600, steerMax: 0.5, steerRate: 5.8,
      grip: 0.82, leanLimitRad: 0.65, fallAngleRad: 0.9 },
  },
  {
    id: 'enduro', category: 'moto', name: 'Enduro',
    summary: 'Moto ligera de tacos para senderos y pendientes.', visual: 'enduro',
    bodySize: { lengthM: 2.12, widthM: 0.78, heightM: 1.28 }, exitOffsetM: 0.9,
    params: { mass: 160, wheelBase: 1.45, wheelRadius: 0.35, maxDriveForce: 1850,
      maxSpeed: 31, brakeForce: 2100, steerMax: 0.56, steerRate: 7.2,
      grip: 0.9, leanLimitRad: 0.72, fallAngleRad: 0.95 },
  },
];

export const DEFAULT_VEHICLE_ID = 'estandar';

export function vehicleById(id: string): VehicleDefinition | undefined {
  return VEHICLE_CATALOG.find((vehicle) => vehicle.id === id);
}
