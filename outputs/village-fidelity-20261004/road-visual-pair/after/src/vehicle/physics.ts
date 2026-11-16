/**
 * Modelo de fuerzas del 4x4 (FASE 4). Reemplaza a `stepCar` del motor de
 * referencia, que era puramente 2D: no tenía gravedad, ni componente de
 * pendiente, ni tracción dependiente del terreno (ver
 * `docs/audit/03-conduccion-jugador-fisica.md`, §2–§3).
 *
 * DECISIONES DE DISEÑO (y por qué):
 *
 * 1. La pendiente se siente de verdad: la gravedad se proyecta sobre el plano
 *    tangente del terreno (`a_long`/`a_lat` más abajo). En cuesta arriba el
 *    término es negativo y frena solo; en bajada acelera solo, aun en punto
 *    muerto. Es el punto central de la tarea.
 *
 * 2. La tracción es un LÍMITE FÍSICO, no un techo de velocidad. La fuerza que
 *    la rueda puede transmitir vale `μ · N`, con `N = m·g·cosθ` (la normal
 *    DISMINUYE en pendiente). Si la fuerza pedida la supera, se recorta y el
 *    vehículo PATINA (`slipping=true`). Consecuencia directa y verificable:
 *    la pendiente máxima escalable tiende a `atan(μ)` porque arriba de eso
 *    `m·g·sinθ > μ·m·g·cosθ` y ningún motor alcanza. Eso es exactamente lo que
 *    NO hacía el modelo 2D.
 *
 * 3. Arrastre de rodadura y aerodinámico SEPARADOS: `Crr·N` (proporcional a la
 *    carga normal, no a la velocidad) y `−k·v·|v|` (cuadrático). El modelo de
 *    referencia metía todo junto (`−v·0.038 − v·|v|·0.0022`) y sin normal.
 *
 * 4. Punto muerto (`neutral`) y freno de mano (`handbrake`) son estados reales:
 *    en punto muerto no hay fuerza de motor ni freno de motor, así que en
 *    bajada el coche rueda y se puede medir `≈ g·sinθ`. El freno de mano aplica
 *    fricción estática mientras `μ·N` alcance a sostener el peso tangencial.
 *
 * 5. Yaw cinemático tipo bicicleta, pero LIMITADO por agarre lateral: si la
 *    aceleración centrípeta pedida supera `μ_lat·N/m`, el eje delantero no
 *    puede girar tanto y el coche SUBVIRALA (`skidding=true`). En llano el
 *    umbral de vuelco (`(vía/2)/h_cg · g`) es mayor que el de derrape, así que
 *    primero derrapa; en ladera lateral fuerte el vuelco se marca como riesgo.
 *
 * Lo que este módulo NO modela (declarado a propósito):
 * - Dinámica de ruedas rígidas / vuelos balísticos: el apoyo vertical se
 *   resuelve aparte con cuatro muelles amortiguados en `suspension.ts`.
 * - Vuelco dinámico real (hay bandera `rolloverRisk`, no una simulación de
 *   voltereta).
 * - La respuesta material fina: los multiplicadores opcionales de `surfaceAt`
 *   distinguen agarre, frenada y rodadura; efectos de audio/partículas viven fuera.
 *
 * Módulo PURO: no importa Babylon ni toca la escena. Se puede transpilar y
 * correr en Node (lo hace `scripts/vehicle/measure_physics.mjs`).
 */

/** Aceleración de la gravedad (m/s²). */
export const GRAVITY = 9.81;

/** Normal unitaria expresada como objeto (compatible con `Vector3` de Babylon). */
export interface Normal3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/**
 * Superficie mínima que necesita la física. `WorldTerrain` la satisface
 * estructuralmente: `heightAt` devuelve Y de MUNDO (datum ya restado) y
 * `normalAt` la normal del terreno. OJO con el footgun de los dos `heightAt`
 * (ver `docs/vehicle/VEHICLE_FASE4.md`): acá SIEMPRE se espera Y de mundo.
 */
export interface VehicleSurface {
  heightAt(x: number, z: number): number;
  normalAt(x: number, z: number): Normal3;
  /** Optional multipliers supplied by the shared world surface system. */
  surfaceAt?(x: number, z: number): VehicleSurfaceSample;
}

/** Structural subset of the world surface definition used by vehicle physics. */
export interface VehicleSurfaceSample {
  readonly type?: 'ROAD' | 'TRACK' | 'PATH' | 'GRASS' | 'MUD' | 'ROCK';
  readonly grip: number;
  readonly lateralGrip: number;
  readonly brakingGrip: number;
  readonly rollingResistance: number;
}

export type VehicleSurfaceType = NonNullable<VehicleSurfaceSample['type']>;

/** Mandos del vehículo, normalizados. */
export interface VehicleInput {
  /** [-1,1] positivo = acelerar, negativo = frenar/reversa. */
  readonly throttle: number;
  /** [-1,1] positivo = derecha. */
  readonly steer: number;
  readonly handbrake: boolean;
  /** Punto muerto: sin motor ni freno de motor. */
  readonly neutral: boolean;
}

/** Estado completo del vehículo. Se muta en el lugar (patrón de la referencia). */
export interface VehicleState {
  x: number;
  z: number;
  /** Ángulo de guiñada (rad). Forward = (sin yaw, cos yaw). */
  yaw: number;
  /** Velocidad longitudinal en el marco del cuerpo (m/s). + adelante. */
  speed: number;
  /** Velocidad lateral (m/s). + hacia la derecha. */
  lateral: number;
  /** Ángulo de rueda suavizado (rad). */
  steer: number;
  /** Guiñada efectiva del último paso (rad/s), ya limitada por agarre. */
  yawRate: number;
  /** Aceleración lateral efectiva del último paso (m/s²). */
  lateralAccel: number;
  /** Odómetro longitudinal (m). */
  distance: number;
  /** Giro acumulado de rueda (rad), para la parte visual. */
  wheelSpin: number;
  /** Último paso: la rueda patina (fuerza recortada por tracción). */
  slipping: boolean;
  /** Último paso: el eje delantero derrapa (no alcanza el agarre lateral). */
  skidding: boolean;
  /** Último paso: la aceleración lateral supera el umbral de vuelco. */
  rolloverRisk: boolean;
  /** El vehículo no apoya las 4 ruedas sobre el terreno (residual > 0.5 m). */
  airborne: boolean;
  neutral: boolean;
  handbrake: boolean;
  /** Pendiente longitudinal CON SIGNO en grados (+ sube). */
  slopeForwardDeg: number;
  /** Pendiente lateral en grados (+ el suelo sube a la derecha). */
  slopeRightDeg: number;
  /** Magnitud de la pendiente en grados. */
  slopeMagnitudeDeg: number;
  /** Componente Y de la normal (coseno de la pendiente). */
  normalY: number;
  /** Límite de tracción del último paso (N). */
  tractionLimitN: number;
  /** Fuerza longitudinal aplicada por el neumático (N). */
  tireForceN: number;
  /** Componente de gravedad a lo largo del vehículo (N). */
  gravityForceN: number;
}

/** Parámetros del 4x4. Todos con default; se pueden pisar por URL o test. */
export interface VehicleParams {
  mass: number;
  wheelBase: number;
  track: number;
  cgHeight: number;
  wheelRadius: number;
  /** Fuerza máxima de tracción a baja velocidad (N). */
  maxDriveForce: number;
  /** Velocidad tope (m/s) a la que la tracción cae a 0. */
  maxSpeed: number;
  /** Fuerza de frenado (N). */
  brakeForce: number;
  /** Fuerza de reversa (N). */
  reverseForce: number;
  /** Fuerza del freno de mano (N). */
  handbrakeForce: number;
  /** Freno de motor al soltar el acelerador (N). */
  engineBrakeForce: number;
  /** Coeficiente de rodadura (adimensional, multiplica la normal). */
  rollingResistance: number;
  /** Arrastre aerodinámico: 0.5·ρ·Cd·A (N·s²/m²). */
  dragCoefficient: number;
  /** Coeficiente de tracción longitudinal μ. La pendiente máxima ≈ atan(μ). */
  grip: number;
  /** Coeficiente de agarre lateral μ_lat. */
  gripLateral: number;
  /** Ángulo máximo de rueda (rad). */
  steerMax: number;
  /** Velocidad de respuesta de la dirección (1/s). */
  steerRate: number;
  /** Coeficiente de amortiguamiento lateral (N por m/s). */
  lateralDamp: number;
  /** Umbral de reposo (m/s) por debajo del cual se considera detenido. */
  staticSpeed: number;
}

export const DEFAULT_VEHICLE_PARAMS: VehicleParams = {
  mass: 1800,
  wheelBase: 2.8,
  track: 1.62,
  cgHeight: 0.78,
  wheelRadius: 0.38,
  maxDriveForce: 14000,
  maxSpeed: 32,
  brakeForce: 12000,
  reverseForce: 6500,
  handbrakeForce: 14000,
  engineBrakeForce: 1200,
  rollingResistance: 0.025,
  dragCoefficient: 0.66,
  grip: 0.8,
  gripLateral: 0.8,
  steerMax: 0.55,
  steerRate: 6,
  lateralDamp: 40000,
  staticSpeed: 0.08,
};

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** Estado inicial en reposo. */
export function createVehicleState(x: number, z: number, yaw = 0): VehicleState {
  return {
    x,
    z,
    yaw,
    speed: 0,
    lateral: 0,
    steer: 0,
    yawRate: 0,
    lateralAccel: 0,
    distance: 0,
    wheelSpin: 0,
    slipping: false,
    skidding: false,
    rolloverRisk: false,
    airborne: false,
    neutral: false,
    handbrake: false,
    slopeForwardDeg: 0,
    slopeRightDeg: 0,
    slopeMagnitudeDeg: 0,
    normalY: 1,
    tractionLimitN: 0,
    tireForceN: 0,
    gravityForceN: 0,
  };
}

/** Fuerza de tracción disponible a una velocidad dada. */
function driveForceAt(params: VehicleParams, speed: number): number {
  // Curva simple: par casi constante a baja velocidad y caída lineal hasta
  // `maxSpeed`. No es la caja real (no hay marchas), pero garantiza que por
  // debajo de atan(μ) el límite lo ponga la TRACCIÓN y no el motor.
  return params.maxDriveForce * clamp(1 - Math.max(speed, 0) / params.maxSpeed, 0, 1);
}

/**
 * Un paso de integración semi-implícita de Euler con `dt` fijo. Exportado para
 * el arnés de medición (pasos deterministas). Para el juego se usa
 * `stepVehicle`, que subdivide.
 */
export function stepVehicleFixed(
  state: VehicleState,
  input: VehicleInput,
  dt: number,
  params: VehicleParams,
  surface: VehicleSurface,
): void {
  if (
    !Number.isFinite(dt) ||
    dt <= 0 ||
    !Number.isFinite(state.x) ||
    !Number.isFinite(state.z) ||
    !Number.isFinite(state.speed)
  ) {
    return;
  }

  // --- Dirección con lag de primer orden (mismo espíritu que la referencia) ---
  const steerTarget = clamp(input.steer, -1, 1) * params.steerMax;
  state.steer += (steerTarget - state.steer) * Math.min(1, dt * params.steerRate);
  state.neutral = input.neutral;
  state.handbrake = input.handbrake;

  const throttle = clamp(input.throttle, -1, 1);

  // --- Base del cuerpo en el mundo ---
  const fx = Math.sin(state.yaw);
  const fz = Math.cos(state.yaw);
  const rx = Math.cos(state.yaw);
  const rz = -Math.sin(state.yaw);

  // --- Pendiente real desde la normal del terreno ---
  const n = surface.normalAt(state.x, state.z);
  const ny = Math.max(n.y, 1e-3);
  const gE = -n.x / ny; // ∂h/∂Este
  const gN = -n.z / ny; // ∂h/∂Norte
  const gF = gE * fx + gN * fz; // ∂h/∂s en el sentido de avance
  const gR = gE * rx + gN * rz; // ∂h/∂s hacia la derecha
  const s2 = 1 + gF * gF + gR * gR;
  const norm = Math.sqrt(s2);

  state.slopeForwardDeg = (Math.atan(gF) * 180) / Math.PI;
  state.slopeRightDeg = (Math.atan(gR) * 180) / Math.PI;
  state.slopeMagnitudeDeg = (Math.atan(Math.hypot(gE, gN)) * 180) / Math.PI;
  state.normalY = ny;

  // Proyección exacta de la gravedad sobre el plano tangente, descompuesta en
  // los ejes del cuerpo. Ver derivación en el informe (VEHICLE_FASE4.md):
  //   a_long = −g·gF / (S·√(1+gR²)),  a_lat = −g·gR / (S·√(1+gF²))
  const aLongG = (-GRAVITY * gF) / (norm * Math.sqrt(1 + gR * gR));
  const aLatG = (-GRAVITY * gR) / (norm * Math.sqrt(1 + gF * gF));

  // --- Carga normal y límite de tracción ---
  // La normal es m·g/S: DISMINUYE con la pendiente. Ahí está la pérdida de agarre.
  const normalLoad = (params.mass * GRAVITY) / norm;
  // Aggregate the four tire footprints. Sampling just the chassis center makes
  // the whole vehicle switch grip at once when only one axle crosses a seam.
  const material = sampleContactSurfaces(state, params, surface);
  const tractionMax = params.grip * (material?.grip ?? 1) * normalLoad;
  state.tractionLimitN = tractionMax;

  // --- Fuerzas longitudinales ---
  let active = 0;
  if (!input.neutral) {
    if (throttle > 0) {
      active = throttle * driveForceAt(params, state.speed);
    } else if (throttle < 0) {
      active = state.speed > 1
        ? throttle * params.brakeForce * (material?.brakingGrip ?? 1)
        : throttle * params.reverseForce;
    }
  }

  let resist = params.rollingResistance * (material?.rollingResistance ?? 1) * normalLoad;
  if (!input.neutral && throttle === 0) resist += params.engineBrakeForce;
  if (input.handbrake) resist += params.handbrakeForce;

  const moving = Math.abs(state.speed) > params.staticSpeed;
  let tire = active;
  if (moving) {
    tire = active - Math.sign(state.speed) * resist;
  } else {
    // EN REPOSO: fricción estática. El freno de mano puede usar TODO el agarre;
    // el drivetrain en marcha (sin acelerar) sostiene hasta el freno de motor
    // más la rodadura. En punto muerto no hay quién sostenga: la rueda gira
    // libre y el coche se escurre (que es justo lo que se quiere medir).
    const need = -params.mass * aLongG;
    let holdMax = 0;
    if (input.handbrake) holdMax = tractionMax;
    else if (!input.neutral && Math.abs(active) < 1e-6) {
      holdMax = Math.min(tractionMax, params.engineBrakeForce + params.rollingResistance * normalLoad);
    }
    if (holdMax > 0 && Math.abs(need) <= holdMax) {
      tire = need;
      state.speed = 0;
    } else if (holdMax > 0) {
      tire = Math.sign(need) * holdMax;
    } else {
      tire = active;
    }
  }

  state.slipping = false;
  if (Math.abs(tire) > tractionMax) {
    tire = Math.sign(tire) * tractionMax;
    state.slipping = true;
  }
  if (Math.abs(active) > tractionMax) state.slipping = true;

  state.tireForceN = tire;
  state.gravityForceN = params.mass * aLongG;

  const aero = -params.dragCoefficient * state.speed * Math.abs(state.speed);
  state.speed += (aLongG + (tire + aero) / params.mass) * dt;

  // Antichattering: con el freno puesto y sin alcanzar a moverse, se queda quieto.
  if (
    input.handbrake &&
    Math.abs(state.speed) < params.staticSpeed &&
    Math.abs(aLongG) * params.mass <= tractionMax
  ) {
    state.speed = 0;
  }

  // --- Lateral: gravedad lateral + amortiguamiento del neumático ---
  const latMax = params.gripLateral * (material?.lateralGrip ?? 1) * normalLoad;
  const latTire = -clamp(state.lateral * params.lateralDamp, -latMax, latMax);
  state.lateral += (aLatG + latTire / params.mass) * dt;

  // --- Guiñada cinemática limitada por agarre lateral ---
  const yawRateKin = (state.speed / params.wheelBase) * Math.tan(state.steer);
  const requiredLatAccel = Math.abs(state.speed * yawRateKin);
  const maxLatAccel = latMax / params.mass;
  let yawRate = yawRateKin;
  state.skidding = false;
  if (requiredLatAccel > maxLatAccel && requiredLatAccel > 1e-4) {
    yawRate *= maxLatAccel / requiredLatAccel;
    state.skidding = true;
  }
  state.yaw += yawRate * dt;
  state.yawRate = yawRate;
  state.lateralAccel = state.speed * yawRate;

  // --- Riesgo de vuelco ---
  // El CG vuelca cuando el vector resultante (centrípeto + componente lateral de
  // la gravedad) apunta fuera de la base de apoyo. En el marco inclinado el peso
  // "normal" es g·n.y, y el brazo es (vía/2)/h_cg. En llano sale ≈1.04 g, más
  // alto que el derrape (0.8 g) ⇒ derrapa antes de volcar. En ladera lateral el
  // umbral efectivo es tanθ > (vía/2)/h_cg ≈ 46°, coherente con la estática.
  const tipThreshold = GRAVITY * ny * (params.track / 2) / params.cgHeight;
  state.rolloverRisk = Math.abs(state.lateralAccel + aLatG) > tipThreshold;

  // --- Integración de posición ---
  const vx = fx * state.speed + rx * state.lateral;
  const vz = fz * state.speed + rz * state.lateral;
  state.x += vx * dt;
  state.z += vz * dt;
  state.distance += Math.abs(state.speed) * dt;

  // Giro visual de rueda: cuando patina, gira de más (rueda loca).
  const spinGain = state.slipping && Math.abs(throttle) > 0 ? 2.2 : 1;
  state.wheelSpin += (state.speed / params.wheelRadius) * dt * spinGain;
}

/** Mean surface response over FL, FR, RL, RR; no resolver preserves legacy values. */
export function sampleContactSurfaces(
  state: Pick<VehicleState, 'x' | 'z' | 'yaw'>,
  params: Pick<VehicleParams, 'wheelBase' | 'track'>,
  surface: VehicleSurface,
): VehicleSurfaceSample | undefined {
  if (!surface.surfaceAt) return undefined;
  const fx = Math.sin(state.yaw), fz = Math.cos(state.yaw);
  const rx = Math.cos(state.yaw), rz = -Math.sin(state.yaw);
  const samples = [
    [-params.track / 2, params.wheelBase / 2], [params.track / 2, params.wheelBase / 2],
    [-params.track / 2, -params.wheelBase / 2], [params.track / 2, -params.wheelBase / 2],
  ].map(([side, front]) => surface.surfaceAt!(
    state.x + side! * rx + front! * fx,
    state.z + side! * rz + front! * fz,
  ));
  const mean = (key: 'grip' | 'lateralGrip' | 'brakingGrip' | 'rollingResistance') =>
    samples.reduce((sum, sample) => sum + sample[key], 0) / samples.length;
  return {
    grip: mean('grip'), lateralGrip: mean('lateralGrip'),
    brakingGrip: mean('brakingGrip'), rollingResistance: mean('rollingResistance'),
    ...(samples[0]!.type && samples.every((sample) => sample.type === samples[0]!.type) ? { type: samples[0]!.type } : {}),
  };
}

/**
 * Paso de juego: subdivide `dt` en pasos de a lo sumo 1/120 s para que la
 * fricción estática y la tracción no exploten con frames largos (el `dt` del
 * frame se clampa a 0.1 s).
 */
export function stepVehicle(
  state: VehicleState,
  input: VehicleInput,
  dt: number,
  params: VehicleParams,
  surface: VehicleSurface,
): void {
  let remaining = clamp(dt, 0, 0.1);
  const maxStep = 1 / 120;
  while (remaining > 1e-9) {
    const h = Math.min(maxStep, remaining);
    stepVehicleFixed(state, input, h, params, surface);
    remaining -= h;
  }
}
