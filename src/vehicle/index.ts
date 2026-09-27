/** Legacy callers retain the mutable four-wheel actor; catalog callers dispatch by category. */
import { createVehicle as createLegacyVehicle, createFourWheelVehicle, type CreateVehicleOptions, type Vehicle } from './four-wheel';
import { createMotorcycle, type Motorcycle } from './motorcycle';
import type { FourWheelDefinition, MotorcycleDefinition, VehicleDefinition } from './catalog';
import type { VehicleActor } from './types';
export { createFourWheelVehicle, createMotorcycle };
export type { Vehicle, VehicleTelemetry, VehicleTerrain, CreateVehicleOptions } from './four-wheel';
export type { Motorcycle, MotorcycleTelemetry } from './motorcycle';

/** Un actor de categoría no-moto cumple el contrato completo de cuatro ruedas. */
export function isFourWheel(actor: VehicleActor): actor is Vehicle {
  return actor.category !== 'moto';
}

export function createVehicle(options: CreateVehicleOptions): Vehicle;
export function createVehicle(options: CreateVehicleOptions, definition: MotorcycleDefinition): Motorcycle;
export function createVehicle(options: CreateVehicleOptions, definition: FourWheelDefinition): Vehicle;
export function createVehicle(options: CreateVehicleOptions, definition: VehicleDefinition): VehicleActor;
export function createVehicle(options: CreateVehicleOptions, definition?: VehicleDefinition): VehicleActor {
  if (!definition) return createLegacyVehicle(options);
  return definition.category === 'moto' ? createMotorcycle(options, definition) : createFourWheelVehicle(options, definition);
}
