/**
 * Contrato de la primera ruta jugable.
 *
 * Estos tipos son de mano: el generador (`scripts/gameplay/build_first_route.mjs`)
 * solo escribe `first-route.ts` (los DATOS). Así se puede cambiar el contrato sin
 * que una regeneración lo pise.
 *
 * Convenciones (ver docs/geo/DECISION_CONVENCION.md):
 *  - `x` = worldX = E − 471500 ; `z` = worldZ = N − 4689000 (z crece al norte).
 *  - `yaw` en radianes, 0 = mirando hacia +Z, y crece hacia +X.
 *    Adelante = (sin(yaw), cos(yaw)). Es la convención de `src/main.ts` y de la
 *    física: `yaw = atan2(dx, dz)` para mirar en la dirección (dx, dz).
 *  - No se guardan alturas: el runtime las pide al terreno. Una sola fuente de
 *    verdad. Si el terreno cambia, la ruta sigue siendo válida en planta.
 */

export interface RoutePoint {
  readonly x: number;
  readonly z: number;
}

/** Clase de vía, espejo de `Road.class` en `public/roads/roads.json`. */
export type RouteLeg = 'ROAD' | 'TRACK' | 'PATH';

/** Rol narrativo del punto de paso. Sirve para guiar sin exigir cada metro. */
export type WaypointRole = 'start' | 'road' | 'junction' | 'track' | 'target';

export interface RouteWaypoint extends RoutePoint {
  readonly role: WaypointRole;
  readonly leg: RouteLeg;
  /** Distancia acumulada desde el inicio, en metros. */
  readonly atM: number;
}

/** Puntos de control de la misión: pocos y con significado, no cada metro. */
export type CheckpointId = 'start' | 'junction' | 'track-entry' | 'target' | 'return';

export interface RouteCheckpoint extends RoutePoint {
  readonly id: CheckpointId;
  readonly label: string;
  readonly atM: number;
}

export interface RouteProfile {
  /** Longitud en planta del trazado, en metros. */
  readonly lengthM: number;
  readonly roadM: number;
  readonly trackM: number;
  readonly pathM: number;
  /** Desnivel acumulado positivo / negativo, en metros. */
  readonly ascentM: number;
  readonly descentM: number;
  /** Pendiente del terreno a lo largo del trazado, muestreada cada 5 m. */
  readonly slopeP50Deg: number;
  readonly slopeP95Deg: number;
  readonly slopeMaxDeg: number;
  /** Tramos de 5 m con pendiente > 20°: el 4x4 trepa ~38°, esto mide el margen. */
  readonly stepsOver20Deg: number;
  /** Radio del peor bache de pendiente: 5 m consecutivos sobre 20°. */
  readonly worstRampDeg: number;
}

export interface FirstRoute {
  readonly id: string;
  readonly name: string;
  /** Script + fecha que lo generaron. Un dato generado sin su origen no es trazable. */
  readonly generatedBy: string;
  readonly sourceSha256: string;
  /** Aparición: sobre asfalto, dentro del pueblo. */
  readonly start: RoutePoint;
  readonly startYaw: number;
  /**
   * Trazado denso (~10 m entre puntos), para conducir o seguir la ruta.
   * Los `waypoints` son la guía con significado (pocos, con rol); esto es la
   * geometría. Un seguidor de ruta necesita ésta: con los waypoints cada ~150 m,
   * un pure-pursuit se come las curvas.
   */
  readonly polyline: readonly RoutePoint[];
  readonly waypoints: readonly RouteWaypoint[];
  /** Punto donde se abandona el asfalto: el jugador "entra en la pista". */
  readonly trackEntry: RoutePoint;
  readonly target: RoutePoint;
  /** Orientación sugerida de la instalación, mirando hacia el valle. */
  readonly targetYaw: number;
  /** Radio libre de vegetación/edificios alrededor del objetivo, en metros. */
  readonly targetClearRadiusM: number;
  /** Punto al que hay que volver: es el mismo inicio (ida y vuelta). */
  readonly returnPoint: RoutePoint;
  readonly checkpoints: readonly RouteCheckpoint[];
  readonly profile: RouteProfile;
}
