/**
 * Controles del jugador (FASE F). ÚNICO lector de teclado del personaje.
 *
 * Por qué UN solo par de listeners: el vehículo ya tiene su propio
 * `src/vehicle/controls.ts`. Si el jugador leyera el teclado por su cuenta y el
 * 4x4 por la suya, ambos mantendrían `Set`s paralelos de las mismas teclas y
 * cualquier `blur`, key-repeat o pérdida de foco los desincroniza. Acá hay un
 * único estado de teclado y de él salen las dos vistas (vehicular y a pie).
 *
 * Teclas:
 *   WASD / flechas   mover a pie, o conducir
 *   Shift            correr (a pie)
 *   E                interactuar (NIVEL, no flanco)
 *   F                entrar/salir del 4x4 (FLANCO)
 *   Espacio          freno de mano (conduciendo)
 *   N                punto muerto (conduciendo)
 *   R                reposicionar (callback del consumidor)
 */

import type { VehicleInput } from '../vehicle/physics';
import type { OnFootInput } from './movement';

export interface PlayerControls {
  /** Input para el 4x4 cuando el jugador conduce. */
  readVehicular(): VehicleInput;
  /** Input a pie cuando el jugador camina. */
  readOnFoot(): OnFootInput;
  /** NIVEL de la tecla E (interacción). No es flanco: se mantiene. */
  readonly interact: boolean;
  /** Consumo de F: true UNA sola vez por pulsación (flanco). */
  consumeToggle(): boolean;
  dispose(): void;
}

export interface PlayerControlsOptions {
  /** Se llama en `keydown` de R (reposicionar). */
  readonly onReset?: (() => void) | undefined;
}

const FORWARD_KEYS = ['KeyW', 'ArrowUp'];
const BACK_KEYS = ['KeyS', 'ArrowDown'];
const LEFT_KEYS = ['KeyA', 'ArrowLeft'];
const RIGHT_KEYS = ['KeyD', 'ArrowRight'];
const RUN_KEYS = ['ShiftLeft', 'ShiftRight'];

function any(keys: ReadonlySet<string>, candidates: readonly string[]): boolean {
  for (const key of candidates) if (keys.has(key)) return true;
  return false;
}

function axis(keys: ReadonlySet<string>, positive: readonly string[], negative: readonly string[]): number {
  const up = any(keys, positive) ? 1 : 0;
  const down = any(keys, negative) ? 1 : 0;
  return up - down;
}

export function createPlayerControls(options: PlayerControlsOptions = {}): PlayerControls {
  const keys = new Set<string>();
  let neutral = false;
  // Flanco de F: se levanta en keydown y se consume en el primer `consumeToggle`.
  let togglePending = false;

  const onKeyDown = (event: KeyboardEvent): void => {
    if (!event.repeat) {
      if (event.code === 'KeyN') neutral = !neutral;
      if (event.code === 'KeyF') togglePending = true;
      if (event.code === 'KeyR') options.onReset?.();
    }
    keys.add(event.code);
    // Evita que Espacio/flechas hagan scroll de la página mientras se juega.
    if (event.code === 'Space' || event.code.startsWith('Arrow')) event.preventDefault();
  };

  const onKeyUp = (event: KeyboardEvent): void => {
    keys.delete(event.code);
  };

  // Al perder foco se sueltan TODAS las teclas: si no, el coche se queda
  // acelerando solo después de un Alt+Tab.
  const onBlur = (): void => {
    keys.clear();
  };

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);

  return {
    readVehicular: () => ({
      throttle: axis(keys, FORWARD_KEYS, BACK_KEYS),
      steer: axis(keys, RIGHT_KEYS, LEFT_KEYS),
      handbrake: keys.has('Space'),
      neutral,
    }),
    readOnFoot: () => ({
      forward: axis(keys, FORWARD_KEYS, BACK_KEYS),
      strafe: axis(keys, RIGHT_KEYS, LEFT_KEYS),
      run: any(keys, RUN_KEYS),
    }),
    get interact() {
      return keys.has('KeyE');
    },
    consumeToggle: () => {
      const pending = togglePending;
      togglePending = false;
      return pending;
    },
    dispose: () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      keys.clear();
      togglePending = false;
    },
  };
}
