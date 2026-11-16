/**
 * Cambio de vehículo transaccional (Tarea 5).
 *
 * El módulo es PURO respecto de Babylon: `main.ts` inyecta la creación, el
 * rebind de cámara/controles/HUD y las reglas de espacio, agua y bajada. Así el
 * camino crítico —validar, crear, publicar, revertir— se prueba sin motor.
 *
 * Garantías:
 * - Sólo se cambia con el vehículo prácticamente detenido (≤ 0,05 m/s).
 * - La pose de destino tiene apoyo firme, espacio libre, agua segura y lugar
 *   para bajarse.
 * - Si el rebind falla a mitad, `rollback()` restaura el estado anterior y el
 *   candidato se descarta; posición, rumbo, misión y almacenamiento no cambian.
 */

import type { VehicleDefinition } from './catalog';
import type { VehicleActor, VehiclePose } from './types';
import type { VehicleTerrain } from './four-wheel';

/** Referencia única al vehículo activo; el jugador la lee en cada paso. */
export interface VehicleRef {
  current: VehicleActor;
}

/** Rebinding preparado por `main.ts`: `commit`/`rollback` idempotente. */
export interface PreparedRebind {
  commit(): void;
  rollback(): void;
}

export interface SwitchContext {
  readonly terrain: VehicleTerrain;
  /** True si el destino no toca edificios, vías ni sus zonas de despeje. */
  canPlace(target: VehicleDefinition, pose: VehiclePose): boolean;
  /** True si el destino no queda sobre agua profunda. */
  waterSafe(target: VehicleDefinition, pose: VehiclePose): boolean;
  /** True si hay espacio para que el jugador se baje del destino. */
  canExit(target: VehicleDefinition, pose: VehiclePose): boolean;
  /** Construye el candidato sin habilitarlo en la escena. */
  create(target: VehicleDefinition, pose: VehiclePose): VehicleActor;
  /** Prepara (sin mutar) cámara, controles y HUD para el nuevo actor. */
  prepareRebind(next: VehicleActor, previous: VehicleActor): PreparedRebind;
  /** Persiste el id elegido. El almacenamiento no disponible no es fatal. */
  persist(id: string): void;
}

export type SwitchCheck = { ok: true; pose: VehiclePose } | { ok: false; reason: string };
export type SwitchResult = { ok: true; vehicle: VehicleActor } | { ok: false; reason: string };

/** Tolerancia de velocidad (longitudinal y lateral) para aceptar un cambio. */
export const SWITCH_SPEED_TOLERANCE_MPS = 0.05;
/** Normal mínima del terreno bajo cada contacto (~60°). */
const MIN_SUPPORT_NORMAL_Y = 0.5;
/** Fracción del largo usada para muestrear los apoyos desde la definición. */
const CONTACT_LONGITUDINAL_FRACTION = 0.35;

function isFallen(actor: VehicleActor): boolean {
  const state = actor.state as { fallen?: boolean; recovering?: boolean };
  return state.fallen === true || state.recovering === true;
}

/** Apoyos aproximados del destino antes de construirlo (huella, no ruedas reales). */
function definitionContacts(target: VehicleDefinition, pose: VehiclePose): VehiclePose[] {
  const fx = Math.sin(pose.yaw);
  const fz = Math.cos(pose.yaw);
  const halfLength = target.bodySize.lengthM * CONTACT_LONGITUDINAL_FRACTION;
  if (target.category === 'moto') {
    return [halfLength, -halfLength].map((sign) => ({ x: pose.x + fx * sign, z: pose.z + fz * sign, yaw: pose.yaw }));
  }
  const rx = Math.cos(pose.yaw);
  const rz = -Math.sin(pose.yaw);
  const halfWidth = target.bodySize.widthM / 2;
  return [
    [-halfWidth, halfLength],
    [halfWidth, halfLength],
    [-halfWidth, -halfLength],
    [halfWidth, -halfLength],
  ].map(([side, front]) => ({
    x: pose.x + side! * rx + front! * fx,
    z: pose.z + side! * rz + front! * fz,
    yaw: pose.yaw,
  }));
}

/**
 * Devuelve la pose segura del cambio o el motivo del rechazo. No muta nada.
 * Se vuelve a llamar antes de publicar el candidato para atrapar movimientos
 * ocurridos durante la construcción.
 */
export function validateSwitchPose(
  current: VehicleActor,
  target: VehicleDefinition,
  context: SwitchContext,
): SwitchCheck {
  if (Math.abs(current.state.speed) > SWITCH_SPEED_TOLERANCE_MPS) {
    return { ok: false, reason: 'El vehículo sigue en movimiento' };
  }
  if (Math.abs(current.state.lateral) > SWITCH_SPEED_TOLERANCE_MPS) {
    return { ok: false, reason: 'El vehículo sigue derrapando' };
  }
  if (isFallen(current)) {
    return { ok: false, reason: 'La moto está caída: recuperala antes de cambiar' };
  }
  const pose: VehiclePose = { x: current.state.x, z: current.state.z, yaw: current.state.yaw };
  const contacts = definitionContacts(target, pose);
  for (const point of contacts) {
    const height = context.terrain.heightAt(point.x, point.z);
    const normal = context.terrain.normalAt(point.x, point.z);
    if (
      !Number.isFinite(height) ||
      !Number.isFinite(normal.x) ||
      !Number.isFinite(normal.y) ||
      !Number.isFinite(normal.z)
    ) {
      return { ok: false, reason: 'Sin terreno válido bajo el destino' };
    }
    if (normal.y < MIN_SUPPORT_NORMAL_Y) {
      return { ok: false, reason: 'El destino no tiene apoyo firme' };
    }
  }
  if (!context.canPlace(target, pose)) return { ok: false, reason: 'No hay espacio libre para el destino' };
  if (!context.waterSafe(target, pose)) return { ok: false, reason: 'El destino cae en agua profunda' };
  if (!context.canExit(target, pose)) return { ok: false, reason: 'No hay lugar para bajarse del destino' };
  return { ok: true, pose };
}

/**
 * Reemplaza el actor activo de forma atómica. El candidato se crea deshabilitado,
 * se publica dentro del `try` del rebind y sólo se confirma si `commit()` termina.
 * Ante cualquier fallo se revierte, se restaura la referencia anterior y el
 * candidato se libera. El actor previo se libera sólo tras el éxito.
 */
export function switchVehicle(ref: VehicleRef, target: VehicleDefinition, context: SwitchContext): SwitchResult {
  const check = validateSwitchPose(ref.current, target, context);
  if (!check.ok) return { ok: false, reason: check.reason };

  const previous = ref.current;
  let candidate: VehicleActor | null = null;
  try {
    candidate = context.create(target, check.pose);
    candidate.root.setEnabled(false);
    // Revalidación final: durante la construcción pudo cambiar la velocidad.
    if (
      Math.abs(previous.state.speed) > SWITCH_SPEED_TOLERANCE_MPS ||
      Math.abs(previous.state.lateral) > SWITCH_SPEED_TOLERANCE_MPS
    ) {
      throw new Error('El vehículo se movió durante el cambio');
    }
    const rebind = context.prepareRebind(candidate, previous);
    try {
      candidate.root.setEnabled(true);
      ref.current = candidate;
      rebind.commit();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      // `rollback` es idempotente: un fallo secundario no puede tapar el original.
      try {
        rebind.rollback();
      } catch {
        /* se continúa con la restauración mínima */
      }
      ref.current = previous;
      candidate.root.setEnabled(false);
      candidate.dispose();
      candidate = null;
      return { ok: false, reason: `No se pudo completar el cambio: ${reason}` };
    }
    previous.dispose();
    context.persist(target.id);
    return { ok: true, vehicle: candidate };
  } catch (error) {
    candidate?.dispose();
    return {
      ok: false,
      reason: `No se pudo crear el vehículo destino: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
