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
  /** Añade o suelta una tecla virtual, usada por los controles táctiles. */
  setVirtualKey(code: string, pressed: boolean): void;
  /** Ejes analógicos del joystick: avance y giro, ambos en el rango [-1, 1]. */
  setVirtualAxes(forward: number, strafe: number): void;
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
  const keyboardKeys = new Set<string>();
  const virtualKeys = new Set<string>();
  let virtualForward = 0;
  let virtualStrafe = 0;
  let neutral = false;
  // Flanco de F: se levanta en keydown y se consume en el primer `consumeToggle`.
  let togglePending = false;

  const onKeyDown = (event: KeyboardEvent): void => {
    if (!event.repeat) {
      if (event.code === 'KeyN') neutral = !neutral;
      if (event.code === 'KeyF') togglePending = true;
      if (event.code === 'KeyR') options.onReset?.();
    }
    keyboardKeys.add(event.code);
    keys.add(event.code);
    // Evita que Espacio/flechas hagan scroll de la página mientras se juega.
    if (event.code === 'Space' || event.code.startsWith('Arrow')) event.preventDefault();
  };

  const onKeyUp = (event: KeyboardEvent): void => {
    keyboardKeys.delete(event.code);
    if (!virtualKeys.has(event.code)) keys.delete(event.code);
  };

  // Al perder foco se sueltan TODAS las teclas: si no, el coche se queda
  // acelerando solo después de un Alt+Tab.
  const onBlur = (): void => {
    keys.clear();
    keyboardKeys.clear();
    virtualKeys.clear();
    virtualForward = 0;
    virtualStrafe = 0;
    // El flanco de F también se tira. Si no, apretás F, cambiás de ventana y al volver
    // el F pendiente dispara solo: entrás o salís del 4x4 sin haber tocado nada.
    togglePending = false;
  };

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);

  return {
    readVehicular: () => ({
      throttle: Math.max(-1, Math.min(1, axis(keys, FORWARD_KEYS, BACK_KEYS) + virtualForward)),
      steer: Math.max(-1, Math.min(1, axis(keys, RIGHT_KEYS, LEFT_KEYS) + virtualStrafe)),
      handbrake: keys.has('Space'),
      neutral,
    }),
    readOnFoot: () => ({
      forward: Math.max(-1, Math.min(1, axis(keys, FORWARD_KEYS, BACK_KEYS) + virtualForward)),
      strafe: Math.max(-1, Math.min(1, axis(keys, RIGHT_KEYS, LEFT_KEYS) + virtualStrafe)),
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
    setVirtualKey: (code, pressed) => {
      if (pressed) {
        if (virtualKeys.has(code)) return;
        virtualKeys.add(code);
        keys.add(code);
        if (code === 'KeyN') neutral = !neutral;
        if (code === 'KeyF') togglePending = true;
        if (code === 'KeyR') options.onReset?.();
        return;
      }
      virtualKeys.delete(code);
      // A keyboard key with the same code may still be held.
      if (!keyboardKeys.has(code)) keys.delete(code);
    },
    setVirtualAxes: (forward, strafe) => {
      virtualForward = Number.isFinite(forward) ? Math.max(-1, Math.min(1, forward)) : 0;
      virtualStrafe = Number.isFinite(strafe) ? Math.max(-1, Math.min(1, strafe)) : 0;
    },
    dispose: () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      keys.clear();
      keyboardKeys.clear();
      virtualKeys.clear();
      virtualForward = 0;
      virtualStrafe = 0;
      togglePending = false;
    },
  };
}
