/**
 * Movimiento a pie (FASE F de la milestone 1). Módulo PURO: no importa Babylon
 * ni toca la escena, así se transpila y se corre en Node
 * (`scripts/player/test_movement.mjs`).
 *
 * DECISIONES DE DISEÑO (y por qué):
 *
 * 1. El input es relativo al MUNDO, no al cuerpo. El contrato no incluye cámara,
 *    y medir "adelante" contra la guiñada ACTUAL hace que mantener D (strafe
 *    puro) pida siempre 90° a la derecha del nuevo rumbo: la dirección pedida
 *    rota junto con el cuerpo y el personaje entra en un trompo infinito. Con el
 *    mundo fijo, W = +Z, D = +X, y la guiñada PERSIGUE esa dirección. Es la
 *    única lectura autocontenida del contrato.
 *
 * 2. La guiñada se interpola con tope de velocidad angular (rad/s): nunca salta
 *    de golpe. Sin input se conserva, como pide el contrato.
 *
 * 3. La velocidad tiene rampa lineal acotada (m/s²), no un cambio instantáneo:
 *    el jugador no es un patín. La diagonal se normaliza, así W+D no es 41% más
 *    rápido que W.
 *
 * 4. `y` sale SIEMPRE de `terrain.heightAt` y la posición se recorta a la
 *    ventana jugable ANTES de muestrear. Fuera de la ventana `heightAt` devuelve
 *    0 y el personaje caería al vacío: es el bug clásico que este módulo evita.
 */

/** Superficie mínima para caminar. `WorldTerrain` la cumple estructuralmente. */
export interface MovementTerrain {
  /** Altura en Y DE MUNDO (datum ya restado). Fuera de la ventana devuelve 0. */
  heightAt(x: number, z: number): number;
}

export interface OnFootInput {
  /** [-1,1] adelante (+Z del mundo). */
  readonly forward: number;
  /** [-1,1] derecha (+X del mundo). */
  readonly strafe: number;
  readonly run: boolean;
}

/** Estado del personaje. Se muta en el lugar (mismo patrón que el vehículo). */
export interface CharacterState {
  x: number;
  z: number;
  y: number;
  yaw: number;
  /** Rapidez horizontal (m/s). */
  speed: number;
  moving: boolean;
}

/**
 * Ventana jugable en unidades de mundo. Espeja `public/terrain/config.json`
 * (`bounds.e = E−471500`, `bounds.n = N−4689000`, 6000 m por lado). El contrato
 * de `MovementTerrain` no expone límites, así que viven acá como constantes.
 */
const WORLD_MIN = 0;
const WORLD_MAX = 6000;

/** Velocidad de caminata (m/s). */
export const WALK_SPEED_MPS = 3.4;
/** Velocidad de carrera (m/s). */
export const RUN_SPEED_MPS = 6.8;
/** Altura de los ojos sobre los pies (m). */
export const EYE_HEIGHT_M = 1.7;

/** Aceleración a pie (m/s²). */
const ACCEL_MPS2 = 12;
/** Frenado a pie (m/s²). */
const BRAKE_MPS2 = 20;
/** Velocidad angular máxima de la guiñada (rad/s). */
const TURN_RATE_RAD_S = 9;
/** dt máximo por paso: un tirón de frame no teletransporta al personaje. */
const MAX_DT_S = 0.1;
/** Por debajo de esta rapidez se considera quieto. */
const MOVING_EPSILON_MPS = 0.05;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function clampToWorld(value: number): number {
  return clamp(value, WORLD_MIN, WORLD_MAX);
}

/** Diferencia angular llevada a [-π, π] para girar por el camino corto. */
function wrapAngle(angle: number): number {
  return Math.atan2(Math.sin(angle), Math.cos(angle));
}

export function createCharacterState(
  x: number,
  z: number,
  yaw: number,
  terrain: MovementTerrain,
): CharacterState {
  const cx = clampToWorld(x);
  const cz = clampToWorld(z);
  return {
    x: cx,
    z: cz,
    y: terrain.heightAt(cx, cz),
    yaw: wrapAngle(yaw),
    speed: 0,
    moving: false,
  };
}

/** Integra un paso. `y` sale de `terrain.heightAt`. */
export function stepCharacter(
  state: CharacterState,
  input: OnFootInput,
  dt: number,
  terrain: MovementTerrain,
): void {
  // Saturación defensiva: ni un dt negativo ni un frame de 1 s deben integrar
  // medio mapa de un salto.
  const step = clamp(Number.isFinite(dt) ? dt : 0, 0, MAX_DT_S);
  if (step <= 0) {
    state.moving = false;
    state.y = terrain.heightAt(clampToWorld(state.x), clampToWorld(state.z));
    return;
  }

  const forward = clamp(Number.isFinite(input.forward) ? input.forward : 0, -1, 1);
  const strafe = clamp(Number.isFinite(input.strafe) ? input.strafe : 0, -1, 1);
  const magnitude = Math.hypot(forward, strafe);
  const hasInput = magnitude > 1e-6;

  if (hasInput) {
    // Dirección de mundo normalizada: la diagonal no suma velocidad.
    const dirX = strafe / magnitude;
    const dirZ = forward / magnitude;
    const targetSpeed = input.run ? RUN_SPEED_MPS : WALK_SPEED_MPS;

    const dv = targetSpeed - state.speed;
    state.speed += Math.sign(dv) * Math.min(Math.abs(dv), ACCEL_MPS2 * step);

    state.x = clampToWorld(state.x + dirX * state.speed * step);
    state.z = clampToWorld(state.z + dirZ * state.speed * step);

    // Guiñada hacia la DIRECCIÓN DE MOVIMIENTO, con tope angular por paso.
    const targetYaw = Math.atan2(dirX, dirZ);
    const delta = wrapAngle(targetYaw - state.yaw);
    const maxTurn = TURN_RATE_RAD_S * step;
    state.yaw = wrapAngle(state.yaw + clamp(delta, -maxTurn, maxTurn));
  } else {
    // Sin input frena en el rumbo actual (no gira: conserva la guiñada).
    state.speed = Math.max(0, state.speed - BRAKE_MPS2 * step);
    if (state.speed > 0) {
      state.x = clampToWorld(state.x + Math.sin(state.yaw) * state.speed * step);
      state.z = clampToWorld(state.z + Math.cos(state.yaw) * state.speed * step);
    }
  }

  state.moving = state.speed > MOVING_EPSILON_MPS;
  state.y = terrain.heightAt(state.x, state.z);
}

/**
 * Punto donde aparece el personaje al bajar del vehículo: al costado derecho,
 * sobre el terreno. El lado derecho del vehículo es `(cos yaw, −sin yaw)`.
 */
export function exitPosition(
  vehicleX: number,
  vehicleZ: number,
  vehicleYaw: number,
  terrain: MovementTerrain,
  sideM = 2.0,
): { x: number; z: number; y: number } {
  const rightX = Math.cos(vehicleYaw);
  const rightZ = -Math.sin(vehicleYaw);
  const x = clampToWorld(vehicleX + rightX * sideM);
  const z = clampToWorld(vehicleZ + rightZ * sideM);
  return { x, z, y: terrain.heightAt(x, z) };
}
