/**
 * Máquina de estados de la misión "Repetidor sin señal". PURO, sin Babylon: se
 * testea en Node (`scripts/gameplay/test_mission.mjs`).
 *
 * Por qué aislada del motor: la misión es una decisión (¿dónde está el jugador,
 * conduce o camina, mantiene E?) y una secuencia de estados. Mezclar esa lógica
 * con meshes la vuelve intestable. Acá entra un `MissionContext` por frame y sale
 * un `MissionSnapshot` listo para el HUD.
 *
 * Convención de distancias: en planta (XZ), en metros. El mundo es Y-up y la cota
 * la resuelve el terreno; para "llegar" a un punto la altura no cambia la cuenta.
 */
// El contrato del packet decía `from './first-route'`, pero `first-route.ts` NO
// re-exporta el tipo (sólo lo importa). El tipo vive en `route-types.ts`, que es
// el contrato de datos. Se importa de ahí para no tocar archivos prohibidos.
import type { FirstRoute } from './route-types';

export type MissionState =
  | 'NOT_STARTED'
  | 'ACTIVE'
  | 'TARGET_REACHED'
  | 'REPAIRED'
  | 'RETURNING'
  | 'COMPLETED';

export interface MissionContext {
  readonly x: number;
  readonly z: number;
  /** Conduciendo el 4x4. */
  readonly driving: boolean;
  /** A pie. Exactamente uno de `driving`/`onFoot` es true. */
  readonly onFoot: boolean;
  /** NIVEL de la tecla de interacción (E), no flanco: se mantiene. */
  readonly interact: boolean;
  readonly dt: number;
}

export interface MissionSnapshot {
  readonly name: string;
  readonly state: MissionState;
  readonly objective: string;
  /** Qué tiene que hacer el jugador AHORA. Se muestra en el HUD. */
  readonly hint: string;
  readonly distanceToTargetM: number;
  readonly distanceToReturnM: number;
  /** 0..1 mientras mantiene E. */
  readonly repairProgress: number;
  readonly repaired: boolean;
  readonly elapsedS: number;
  readonly completed: boolean;
}

export interface Mission {
  readonly route: FirstRoute;
  readonly snapshot: MissionSnapshot;
  update(ctx: MissionContext): MissionSnapshot;
  reset(): void;
}

export interface MissionOptions {
  /** Radio (m) de las TRANSICIONES de estado: llegaste al claro, se te considera de vuelta. */
  readonly reachRadiusM?: number;
  /**
   * Radio (m) del INTERACTUABLE del objetivo: desde dónde se puede reparar. El
   * llamador lo lee del propio repetidor (`interactable.radiusM`) para que el aviso
   * de `E` y el progreso de la reparación no puedan divergir.
   */
  readonly repairRadiusM?: number;
  readonly repairSeconds?: number;
}

/** Título de la misión (es el nombre, no el de la ruta: pueden divergir). */
export const MISSION_NAME = 'REPETIDOR SIN SEÑAL';
const MISSION_OBJECTIVE = 'Llegá al repetidor al fondo de la pista, restablecé el enlace y volvé a Villafranca';

const DEFAULT_REACH_RADIUS_M = 25;
/** Radio de reparación por defecto (m). El objetivo real declara el suyo y manda. */
const DEFAULT_REPAIR_RADIUS_M = 6;
const DEFAULT_REPAIR_SECONDS = 2;

function planarDistance(ax: number, az: number, bx: number, bz: number): number {
  return Math.hypot(ax - bx, az - bz);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

export function createMission(route: FirstRoute, options: MissionOptions = {}): Mission {
  const reachRadiusM = options.reachRadiusM ?? DEFAULT_REACH_RADIUS_M;
  // Dos radios, no uno. Llegar al claro del repetidor (25 m) NO es lo mismo que
  // estar poniéndole la mano encima (el radio del interactuable). Fundidos en uno
  // solo, el juego decía "mantené E" a 20 m y además te dejaba reparar desde ahí.
  const repairRadiusM = options.repairRadiusM ?? DEFAULT_REPAIR_RADIUS_M;
  // Un `repairSeconds` no positivo haría que el primer frame repare: se cae al
  // default en vez de romper la regla "mantené E".
  const repairSeconds = options.repairSeconds && options.repairSeconds > 0 ? options.repairSeconds : DEFAULT_REPAIR_SECONDS;

  let state: MissionState = 'NOT_STARTED';
  let elapsedS = 0;
  /** Segundos acumulados con E mantenida a pie y en rango. Se RESETEA si no. */
  let repairHeldS = 0;

  const distanceToTarget = (x: number, z: number): number => planarDistance(x, z, route.target.x, route.target.z);
  const distanceToReturn = (x: number, z: number): number => planarDistance(x, z, route.returnPoint.x, route.returnPoint.z);

  const repairProgress = (): number => {
    // Terminada (o más allá), el progreso es 1 para que la baliza quede verde.
    if (state === 'REPAIRED' || state === 'RETURNING' || state === 'COMPLETED') return 1;
    if (state !== 'TARGET_REACHED') return 0;
    return clamp01(repairHeldS / repairSeconds);
  };

  const hintFor = (ctx: MissionContext, distanceToTargetM: number): string => {
    switch (state) {
      case 'NOT_STARTED':
        return 'Entrá al 4x4 (F) para arrancar';
      case 'ACTIVE':
        return 'Seguí la pista hasta el repetidor';
      case 'TARGET_REACHED':
        // Reparar desde el coche NO vale: si conduce, primero que baje.
        if (ctx.driving) return 'Bajá del 4x4 (F) y acercate';
        if (!ctx.onFoot) return 'Acercate al repetidor';
        // El aviso de "mantené E" tiene que aparecer EXACTAMENTE donde E funciona.
        if (distanceToTargetM > repairRadiusM) return 'Acercate al repetidor';
        return 'Mantené E para restablecer el enlace';
      case 'REPAIRED':
      case 'RETURNING':
        return 'Volvé a Villafranca';
      case 'COMPLETED':
        return 'Misión cumplida';
    }
  };

  const buildSnapshot = (ctx: MissionContext, distanceToTargetM: number, distanceToReturnM: number): MissionSnapshot => ({
    name: MISSION_NAME,
    state,
    objective: MISSION_OBJECTIVE,
    hint: hintFor(ctx, distanceToTargetM),
    distanceToTargetM,
    distanceToReturnM,
    repairProgress: repairProgress(),
    repaired: state === 'REPAIRED' || state === 'RETURNING' || state === 'COMPLETED',
    elapsedS,
    completed: state === 'COMPLETED',
  });

  /** Contexto sintético para el snapshot inicial (aún no llegó ningún frame). */
  const initialCtx: MissionContext = { x: route.start.x, z: route.start.z, driving: false, onFoot: true, interact: false, dt: 0 };
  let current = buildSnapshot(initialCtx, distanceToTarget(route.start.x, route.start.z), distanceToReturn(route.start.x, route.start.z));

  const update = (ctx: MissionContext): MissionSnapshot => {
    // `dt` sano: NaN, infinito o negativo no debe mover el reloj ni reparar. Un
    // frame con dt=0 tiene que ser inofensivo (capturas y test lo verifican).
    const dt = Number.isFinite(ctx.dt) && ctx.dt > 0 ? ctx.dt : 0;
    const distanceToTargetM = distanceToTarget(ctx.x, ctx.z);
    const distanceToReturnM = distanceToReturn(ctx.x, ctx.z);

    // Transiciones con `if` encadenados (no `else if`): un mismo frame puede
    // avanzar más de un estado, p. ej. arrancar a conducir ya dentro del radio.
    if (state === 'NOT_STARTED' && ctx.driving) state = 'ACTIVE';
    if (state === 'ACTIVE' && distanceToTargetM <= reachRadiusM) state = 'TARGET_REACHED';
    if (state === 'TARGET_REACHED') {
      // Reparar exige ESTAR A PIE y DENTRO del radio. Si suelta E o se aleja, el
      // progreso se resetea (no se congela): no se puede "cocinar" la reparación.
      const inRangeOnFoot = ctx.onFoot && distanceToTargetM <= repairRadiusM;
      if (inRangeOnFoot && ctx.interact) {
        repairHeldS += dt;
        if (repairHeldS >= repairSeconds) state = 'REPAIRED';
      } else {
        repairHeldS = 0;
      }
    }
    if (state === 'REPAIRED' && ctx.driving) state = 'RETURNING';
    if (state === 'RETURNING' && distanceToReturnM <= reachRadiusM) state = 'COMPLETED';

    // El reloj corre desde ACTIVO y se detiene al completar (COMPLETED es terminal).
    if (state !== 'NOT_STARTED' && state !== 'COMPLETED') elapsedS += dt;

    current = buildSnapshot(ctx, distanceToTargetM, distanceToReturnM);
    return current;
  };

  const reset = (): void => {
    state = 'NOT_STARTED';
    elapsedS = 0;
    repairHeldS = 0;
    current = buildSnapshot(initialCtx, distanceToTarget(route.start.x, route.start.z), distanceToReturn(route.start.x, route.start.z));
  };

  return {
    route,
    get snapshot(): MissionSnapshot {
      return current;
    },
    update,
    reset,
  };
}
