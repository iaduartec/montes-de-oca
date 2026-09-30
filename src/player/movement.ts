/**
 * Movimiento a pie (FASE F de la milestone 1). Módulo PURO: no importa Babylon
 * ni toca la escena, así se transpila y se corre en Node
 * (`scripts/player/test_movement.mjs`).
 *
 * DECISIONES DE DISEÑO (y por qué):
 *
 * 1. W/S avanzan y retroceden según la guiñada del personaje; A/D giran el rumbo.
 *    La cámara de persecución sigue esa guiñada, así que el jugador siempre puede
 *    avanzar hacia lo que ve. Mantener A/D gira en el sitio y no usa la dirección
 *    de giro como vector de movimiento.
 *
 * 2. La guiñada avanza a velocidad angular acotada (rad/s): nunca salta de golpe.
 *
 * 3. La velocidad tiene rampa lineal acotada (m/s²), no un cambio instantáneo:
 *    el jugador no es un patín. El giro se puede combinar con W/S.
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
  /** [-1,1] adelante/atrás según el rumbo del personaje. */
  readonly forward: number;
  /** [-1,1] giro: negativo a la izquierda, positivo a la derecha. */
  readonly turn: number;
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
export const TURN_RATE_RAD_S = 4.5;
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
  const turn = clamp(Number.isFinite(input.turn) ? input.turn : 0, -1, 1);
  const maxSpeed = input.run ? RUN_SPEED_MPS : WALK_SPEED_MPS;
  const targetSpeed = forward * maxSpeed;
  const dv = targetSpeed - state.speed;
  const acceleration = Math.abs(forward) > 1e-6 ? ACCEL_MPS2 : BRAKE_MPS2;
  state.speed += Math.sign(dv) * Math.min(Math.abs(dv), acceleration * step);

  // A/D giran el personaje y la cámara; W/S siempre usan ese mismo rumbo.
  state.yaw = wrapAngle(state.yaw + turn * TURN_RATE_RAD_S * step);
  state.x = clampToWorld(state.x + Math.sin(state.yaw) * state.speed * step);
  state.z = clampToWorld(state.z + Math.cos(state.yaw) * state.speed * step);

  state.moving = Math.abs(state.speed) > MOVING_EPSILON_MPS;
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
