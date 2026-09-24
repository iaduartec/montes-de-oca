/**
 * Mandos de teclado del 4x4. Sigue el patrón de la referencia (`city-world.ts`
 * mantiene un `Set` de teclas y recompone el input por frame), en vez de inventar
 * un sistema de acciones.
 *
 * Teclas:
 *   W / ↑          acelerar
 *   S / ↓          frenar / reversa
 *   A / D / ← / →  girar
 *   Espacio        freno de mano
 *   N              punto muerto (toggle)
 *   R              reposicionar (lo maneja main.ts)
 */

import type { VehicleInput } from './physics';

export interface VehicleControlsOptions {
  /** Se llama en `keydown` de R (reposicionar vehículo). */
  onReset?: (() => void) | undefined;
}

export interface VehicleControls {
  /** Recompone el input a partir del estado actual del teclado. */
  read(): VehicleInput;
  /** Punto muerto activo (para el HUD). */
  isNeutral(): boolean;
  dispose(): void;
}

const FORWARD_KEYS = ['KeyW', 'ArrowUp'];
const BACK_KEYS = ['KeyS', 'ArrowDown'];
const LEFT_KEYS = ['KeyA', 'ArrowLeft'];
const RIGHT_KEYS = ['KeyD', 'ArrowRight'];

function any(keys: ReadonlySet<string>, candidates: readonly string[]): boolean {
  for (const key of candidates) if (keys.has(key)) return true;
  return false;
}

function axis(keys: ReadonlySet<string>, positive: readonly string[], negative: readonly string[]): number {
  const up = any(keys, positive) ? 1 : 0;
  const down = any(keys, negative) ? 1 : 0;
  return up - down;
}

export function createVehicleControls(options: VehicleControlsOptions = {}): VehicleControls {
  const keys = new Set<string>();
  let neutral = false;

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.repeat) {
      // El toggle de punto muerto no debe repetirse al mantener N.
      keys.add(event.code);
      return;
    }
    if (event.code === 'KeyN') neutral = !neutral;
    if (event.code === 'KeyR') options.onReset?.();
    keys.add(event.code);
    // Evita que Espacio/flechas hagan scroll de la página mientras se conduce.
    if (event.code === 'Space' || event.code.startsWith('Arrow')) event.preventDefault();
  };

  const onKeyUp = (event: KeyboardEvent): void => {
    keys.delete(event.code);
  };

  const onBlur = (): void => {
    keys.clear();
  };

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);

  return {
    read: () => ({
      throttle: axis(keys, FORWARD_KEYS, BACK_KEYS),
      steer: axis(keys, RIGHT_KEYS, LEFT_KEYS),
      handbrake: keys.has('Space'),
      neutral,
    }),
    isNeutral: () => neutral,
    dispose: () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    },
  };
}
