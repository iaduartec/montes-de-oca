import { Engine } from '@babylonjs/core/Engines/engine';
import { Scene } from '@babylonjs/core/scene';
import { UniversalCamera } from '@babylonjs/core/Cameras/universalCamera';
import { Ray } from '@babylonjs/core/Culling/ray';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { Color4 } from '@babylonjs/core/Maths/math.color';
import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh';
import { loadTerrainConfig, TERRAIN_CONFIG_PATH, wgs84ToWorld } from './config';
import { publicUrl } from './public-url';
import { createDiagnostics, formatActorHud, type DiagnosticsSnapshot } from './diagnostics';
import { auditVerticalDatum, loadTerrain, type WorldTerrain } from './terrain';
import { gridExtent } from './heightfield';
import { loadWater, type Water, type WaterStats } from './environment/water';
import { loadVillage, type VillageStats } from './environment/village';
import { loadVillageLandmarks, type VillageLandmarks } from './environment/village-landmarks';
import { VILLAGE_ROAD_CLEARANCE_QUERY_RADIUS_M } from './environment/roof-clearance';
import {
  loadVegetation,
  type Vegetation,
  type VegetationCorridor,
  type VegetationStats,
} from './environment/vegetation';
import { createAtmosphere, type Atmosphere } from './environment/atmosphere';
import {
  loadRoadNetwork,
  type RoadAuditReport,
  type RoadDrapingStats,
  type RoadNetwork,
  type RoadProbe,
  type RoadStation,
} from './road-draping';
import { createVehicle, isFourWheel, type CreateVehicleOptions } from './vehicle/index';
import { createVehicleControls } from './vehicle/controls';
import type { VehicleInput, VehicleParams } from './vehicle/physics';
import { DEFAULT_VEHICLE_ID, vehicleById, type VehicleDefinition } from './vehicle/catalog';
import { switchVehicle, type PreparedRebind, type SwitchContext, type VehicleRef } from './vehicle/switch';
import type { VehicleActor, VehicleActorTelemetry, VehiclePose } from './vehicle/types';
import { createVehicleSelector, type VehicleSelector } from './vehicle/selector';
import { createMinimap, type Minimap } from './ui/minimap';
import { FIRST_ROUTE } from './gameplay/first-route';
import type { FirstRoute, RouteLeg, RoutePoint } from './gameplay/route-types';
import { createPlayer, type Player, type PlayerTelemetry } from './player/index';
import { createPlayerControls, type PlayerControls } from './player/controls';
import { exitPosition } from './player/movement';
import {
  MISSION_NAME,
  createMission,
  type Mission,
  type MissionSnapshot,
  type MissionState,
} from './gameplay/mission';
import { createInteractor, type Interactor } from './gameplay/interact';
import { createRepeaterObjective, type Objective } from './gameplay/objective';

const canvas = document.getElementById('render-canvas');
const hud = document.getElementById('hud');
const misionEl = document.getElementById('mision');
const accionEl = document.getElementById('accion');
const avisoEl = document.getElementById('aviso');
const controlsEl = document.getElementById('controls');

/** Teclas del modo cámara libre; sólo se muestran cuando la ayuda está activa (F3). */
const CONTROLES_LIBRE =
  'WASD/flechas: mover · Mouse: mirar · Clic en el canvas para capturar el puntero · Shift: acelerar · V: vehículo';

/** Pista persistente mínima: recuerda que F3 revela las teclas y el diagnóstico. */
const PISTA_AYUDA = 'F3: ayuda y diagnóstico';

/**
 * Avisos de acción. Son constantes cerradas a propósito: se escriben con
 * `innerHTML` para poder usar `<kbd>`, y sin interpolación no hay superficie de
 * inyección. Si algún día el texto depende de datos, hay que cambiar a nodos.
 */
const AVISO_ENTRAR = '<kbd>F</kbd> — entrar al 4x4';
const AVISO_BAJAR = '<kbd>F</kbd> — bajar del 4x4';
const AVISO_REPARAR = '<kbd>E</kbd> — mantener para restablecer el enlace';

/** Estado del 4x4 respecto del agua (AGUA §5.2/§5.3). Lo lee el arnés de T6. */
export type EstadoAgua = 'seco' | 'vadeando' | 'arrastrando' | 'hundiendo' | 'enfangado';

/**
 * Texto fijo del aviso de rescate (§5.3.3). Vive también en `index.html#aviso`;
 * se reescribe al mostrarlo para que el arnés lea siempre el mismo texto.
 */
const AVISO_HUNDIDO = 'El 4x4 se hundió — volvés a la orilla';
/** Hasta acá el vado es pasable con arrastre leve (§5.2). */
const AGUA_VADEO_M = 0.35;
/** Por encima el agua dispara la secuencia de hundimiento (§5.2). */
const AGUA_HUNDIMIENTO_M = 1.1;
/** Velocidad objetivo con arrastre alto, dentro del agua (§5.2). */
const AGUA_VELOCIDAD_ARRASTRE_MPS = 3.5;
/** Velocidad objetivo vadeando: paso normal con arrastre leve (§5.2). */
const AGUA_VELOCIDAD_VADEO_MPS = 9;
/** La secuencia de hundimiento rescata a este tiempo (§5.3.3). */
const AGUA_HUNDIMIENTO_S = 1.5;
/** Tope del calado visual: la lámina tapa el modelo (§5.3.2). */
const AGUA_CALADO_MAX_M = 1.5;
/** Enfangado: sin avanzar con gas durante este tiempo (§5.2). */
const AGUA_ENFANGADO_S = 3;
const AGUA_ENFANGADO_VELOCIDAD_MPS = 0.4;
/** El aviso se muestra este tiempo; el juego no se pausa (§5.3.3). */
const AVISO_HUNDIDO_MS = 4000;

const ETIQUETA_ESTADO: Record<MissionState, string> = {
  NOT_STARTED: 'SIN EMPEZAR',
  ACTIVE: 'EN MARCHA',
  TARGET_REACHED: 'EN EL REPETIDOR',
  REPAIRED: 'ENLACE RESTABLECIDO',
  RETURNING: 'REGRESANDO',
  COMPLETED: 'COMPLETADA',
};

function formatMinutos(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/**
 * Entrada inyectada por un guion de medición, en lugar del teclado.
 *
 * Es la pieza que hace posible el check de navegador OBLIGATORIO de la milestone:
 * con el personaje como único lector de teclado, un arnés no puede ni entrar al 4x4
 * ni caminar. Se inyecta en el MISMO punto donde el personaje lee su entrada, así
 * que el camino de código que se mide es el mismo que usa el jugador.
 */
interface InjectedInput {
  readonly forward?: number;
  readonly strafe?: number;
  readonly run?: boolean;
  readonly throttle?: number;
  readonly steer?: number;
  readonly handbrake?: boolean;
  readonly neutral?: boolean;
  /** Nivel de la tecla E. */
  readonly interact?: boolean;
  /** Pulsación de F: se consume al leerla. */
  readonly toggle?: boolean;
}

if (!(canvas instanceof HTMLCanvasElement)) {
  throw new Error('No se encontró el canvas #render-canvas');
}

const engine = new Engine(canvas, true, {
  preserveDrawingBuffer: true,
  stencil: true,
  antialias: true,
});

const scene = new Scene(engine);
scene.clearColor = new Color4(0.53, 0.68, 0.82, 1);

// Iluminación y atmósfera: las crea `createAtmosphere` al final del bootstrap, cuando
// ya existen las mallas que proyectan sombra. Un solo dueño de las luces — si además
// se crearan acá, habría dos juegos sumando intensidad.

const camera = new UniversalCamera('camara-libre', new Vector3(0, 80, -160), scene);
camera.attachControl(canvas, true);
camera.speed = 6;
camera.angularSensibility = 4000;
camera.inertia = 0.75;
camera.minZ = 0.5;
camera.maxZ = 40000;

/** Lee un número de la query string si es válido. */
function queryNumber(params: URLSearchParams, key: string): number | null {
  const raw = params.get(key);
  if (raw === null || raw.trim() === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/**
 * Clave del parche original del selector de vehículos: se conserva para que la
 * futura UI (fase 2) lea la misma selección. Accesos guardados con try/catch
 * porque localStorage puede no estar disponible (modo privado, SSR).
 */
const SELECTED_VEHICLE_KEY = 'selectedVehicleId';

function readStoredVehicleId(): string | null {
  try {
    return window.localStorage.getItem(SELECTED_VEHICLE_KEY);
  } catch {
    return null;
  }
}

function writeStoredVehicleId(id: string): void {
  try {
    window.localStorage.setItem(SELECTED_VEHICLE_KEY, id);
  } catch {
    // Sin almacenamiento: la selección vive sólo en memoria.
  }
}

/** Semiancho de despeje por clase de vía: MISMO criterio que el generador. */
const CORRIDOR_HALF_WIDTH: Record<RouteLeg, number> = { ROAD: 12, TRACK: 8, PATH: 4 };

/**
 * Divide la polilínea densa de la ruta en corredores por clase de vía, con la misma
 * semántica que `buildRouteCorridors` de `scripts/environment/build_vegetation.mjs`:
 * un corte por cada cambio de `leg`, ubicado en el `atM` del último waypoint del tramo
 * anterior. Sin esto, los 12 m del asfalto se aplicaban a TODA la pista y la vegetación
 * decorativa quedaba excluida de más (`excludedByCorridor` inflado).
 */
function routeCorridors(route: FirstRoute): VegetationCorridor[] {
  const poly = route.polyline;
  if (poly.length < 2) return [];

  const cum: number[] = [0];
  for (let i = 1; i < poly.length; i++) {
    const a = poly[i - 1]!;
    const b = poly[i]!;
    cum.push(cum[i - 1]! + Math.hypot(b.x - a.x, b.z - a.z));
  }
  const total = cum[cum.length - 1]!;

  const pointAt = (d: number): RoutePoint => {
    const first = poly[0]!;
    const last = poly[poly.length - 1]!;
    if (d <= 0) return { x: first.x, z: first.z };
    if (d >= total) return { x: last.x, z: last.z };
    let k = 0;
    while (k < cum.length - 2 && cum[k + 1]! < d) k++;
    const span = cum[k + 1]! - cum[k]!;
    const t = span > 0 ? (d - cum[k]!) / span : 0;
    const a = poly[k]!;
    const b = poly[k + 1]!;
    return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t };
  };

  const cuts: { atM: number; leg: RouteLeg }[] = [];
  for (let i = 1; i < route.waypoints.length; i++) {
    const prev = route.waypoints[i - 1]!;
    const cur = route.waypoints[i]!;
    if (cur.leg !== prev.leg) cuts.push({ atM: prev.atM, leg: cur.leg });
  }
  const bounds = [0, ...cuts.map((c) => c.atM), total];
  const legs: RouteLeg[] = [route.waypoints[0]?.leg ?? 'ROAD', ...cuts.map((c) => c.leg)];

  const corridors: VegetationCorridor[] = [];
  for (let k = 0; k < legs.length; k++) {
    const from = bounds[k]!;
    const to = bounds[k + 1]!;
    if (!(to > from)) continue;
    const points: RoutePoint[] = [pointAt(from)];
    for (let i = 0; i < poly.length; i++) {
      if (cum[i]! <= from || cum[i]! >= to) continue;
      const prev = points[points.length - 1]!;
      const p = poly[i]!;
      if (Math.hypot(p.x - prev.x, p.z - prev.z) > 0.05) points.push(p);
    }
    points.push(pointAt(to));
    if (points.length >= 2) corridors.push({ points, halfWidthM: CORRIDOR_HALF_WIDTH[legs[k]!] });
  }
  return corridors;
}

function formatSnapshot(snapshot: DiagnosticsSnapshot, terrain: WorldTerrain): string {
  const center = terrain.center();
  return [
    `FPS        ${snapshot.fps.toFixed(0)}`,
    `frame      ${snapshot.frameTimeMs.toFixed(2)} ms`,
    `draw calls ${snapshot.drawCalls.toFixed(0)}`,
    `triángulos ${snapshot.triangles.toFixed(0)}`,
    `en vista   ${terrain.activeTriangles().toFixed(0)} (radio ${terrain.viewRadius.toFixed(0)} m)`,
    `vértices   ${snapshot.vertices.toFixed(0)}`,
    `mallas     ${snapshot.activeMeshes}`,
    `tiles      ${terrain.samplers.length}`,
    `centro     x=${center.x.toFixed(0)} z=${center.z.toFixed(0)} y=${center.height.toFixed(1)}`,
  ].join('\n');
}

function formatPlayerHud(t: PlayerTelemetry): string {
  const modo = t.mode === 'driving' ? 'conduciendo' : 'a pie';
  return [
    `jugador    ${modo}`,
    `posición   x=${t.x.toFixed(1)} z=${t.z.toFixed(1)} y=${t.y.toFixed(1)}`,
    `velocidad  ${t.speedMps.toFixed(2)} m/s${t.running ? ' · corriendo' : ''}`,
    `al 4x4     ${t.distanceToVehicleM.toFixed(1)} m${t.canEnter ? ' · podés entrar' : ''}`,
  ].join('\n');
}

/** API de depuración/medición expuesta en `window.__game` para CDP. */
interface DebugApi {
  terrainHeightAt(x: number, z: number): number;
  terrainNormalAt(x: number, z: number): { x: number; y: number; z: number };
  perf(): DiagnosticsSnapshot;
  auditDatum(): { verticalDatum: number; maxAbsDiffM: number; ok: boolean; samples: readonly unknown[] };
  vehicle: {
    telemetry(): VehicleActorTelemetry;
    /** Categoría del actor activo (`todoterreno` | `coche` | `moto`). */
    category(): string;
    setInput(input: VehicleInput | null): void;
    teleport(x: number, z: number, yaw: number): void;
    setState(partial: Partial<{ x: number; z: number; yaw: number; speed: number; lateral: number }>): void;
    /** Sólo cuatro ruedas: devuelve false si el activo es una moto. */
    setParams(partial: Partial<VehicleParams>): boolean;
    params(): VehicleParams | null;
    /** Id del vehículo activo (`estandar` por defecto). */
    preset(): string;
    /** Cambia a un id del catálogo, lo persiste y devuelve false si no existe o no se puede. */
    setPreset(id: string): boolean;
    /** Recupera una moto caída; false para cuatro ruedas o si no hay apoyo válido. */
    recover(): boolean;
    step(seconds: number, dt?: number): void;
    reset(): void;
  } | null;
  roads: {
    stats(): RoadDrapingStats;
    audit(): RoadAuditReport;
    probe(count: number): RoadProbe[];
    stations(): RoadStation[];
  } | null;
  /** La ruta de la milestone, para que los arneses no la dupliquen a mano. */
  route: FirstRoute | null;
  /** El agua decorativa cargada (AGUA T4). `null` con `?water=0` o si falló la carga. */
  water: {
    stats(): WaterStats;
    depthAt(x: number, z: number): number;
    isMuddy(x: number, z: number): boolean;
    nearestSafeShore(x: number, z: number): { x: number; z: number } | null;
    /** Estado de la regla del agua (AGUA T6): lo usa el arnés `drive_water.mjs`. */
    estadoAgua(): EstadoAgua;
    /** Calado visual actual del 4x4, en metros (cuánto baja el modelo). */
    calado(): number;
  } | null;
  /** El pueblo low-poly cargado (FASE E). `null` con `?pueblo=0`. */
  village: { stats(): VillageStats } | null;
  /** La vegetación procedural cargada (FASE D). `null` con `?vegetation=0`. */
  vegetation: { stats(): VegetationStats } | null;
  player: {
    mode(): 'on-foot' | 'driving';
    telemetry(): PlayerTelemetry;
    toggleVehicle(): 'on-foot' | 'driving';
    teleport(x: number, z: number, yaw: number): void;
    /** Inyecta entrada en vez de teclearla. `null` devuelve el control al teclado. */
    inject(input: InjectedInput | null): void;
    /** Paso manual determinista: avanza mundo y misión, igual que el render loop. */
    step(seconds: number, dt?: number): void;
  } | null;
  mission: {
    name: string;
    snapshot(): MissionSnapshot;
    reset(): void;
  } | null;
}

declare global {
  interface Window {
    __game?: DebugApi;
  }
}

function showError(message: string): void {
  console.error(message);
  if (hud) {
    hud.hidden = false;
    hud.textContent = `ERROR\n${message}`;
    hud.classList.add('hud-error');
  }
}

async function bootstrap(): Promise<void> {
  // La primera carga (terreno, pueblo, vegetación) tarda segundos: el cartel de carga
  // arranca visible desde el primer momento y recién se libera al final de bootstrap.
  if (hud) {
    hud.hidden = false;
    hud.textContent = 'Cargando terreno…';
  }
  const config = await loadTerrainConfig(fetch, publicUrl(TERRAIN_CONFIG_PATH));
  const terrain = await loadTerrain(scene, {
    ...config,
    tiles: config.tiles.map((tile) => ({ ...tile, url: publicUrl(tile.url) })),
  });

  const params = new URLSearchParams(window.location.search);
  // Ayuda y diagnóstico comparten conmutador: en estado normal sólo queda una pista
  // compacta y F3 revela las teclas de control y el panel de instrumentación.
  let ayudaVisible = params.get('debug') === '1';
  // El panel se queda con el mensaje de carga hasta que arranca el render (final de
  // bootstrap): ocultarlo acá dejaba la pantalla vacía durante la carga de pueblo y
  // vegetación, justo el tramo más largo en el móvil.
  window.addEventListener('keydown', (event) => {
    // El selector de vehículo vive en `selectorVehiculo` (se crea con el 4x4);
    // si aún no existe (carga), la V no hace nada.
    if (event.code === 'KeyV' && !event.repeat) {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
      selectorVehiculo?.toggle();
      return;
    }
    if (event.code !== 'F3') return;
    event.preventDefault();
    ayudaVisible = !ayudaVisible;
    if (hud) hud.hidden = !ayudaVisible;
  });

  // Punto de aparición: el config trae el pueblo en WGS84; si no, el centro.
  const center = terrain.center();
  let spawnX = center.x;
  let spawnZ = center.z;
  if (config.spawn) {
    const [worldX, worldZ] = wgs84ToWorld(config, config.spawn.lon, config.spawn.lat);
    spawnX = worldX;
    spawnZ = worldZ;
  }

  // La cámara libre histórica se activa con px/py/pz (capturas de terreno). Sin
  // esos parámetros arranca el MODO VEHÍCULO con cámara de persecución.
  const px = queryNumber(params, 'px');
  const py = queryNumber(params, 'py');
  const pz = queryNumber(params, 'pz');
  const tx = queryNumber(params, 'tx');
  const ty = queryNumber(params, 'ty');
  const tz = queryNumber(params, 'tz');
  const freeCamera = px !== null || py !== null || pz !== null;
  // Modo medición = instrumentación a la vista: un arnés que pide cámara libre quiere
  // el panel de diagnóstico, sin depender de que alguien recuerde `?debug=1`.
  if (freeCamera) ayudaVisible = true;

  // ----- Auditoría del footgun de los dos heightAt (ver src/terrain.ts) -----
  const auditPoints: { x: number; z: number }[] = [];
  for (const sampler of terrain.samplers) {
    const grid = sampler.grid;
    const midX = grid.x0 + ((grid.columns - 1) * grid.dx) / 2;
    const midZ = grid.z0 + ((grid.rows - 1) * grid.dz) / 2;
    auditPoints.push({ x: midX, z: midZ });
  }
  auditPoints.push({ x: spawnX, z: spawnZ });
  const datumAudit = auditVerticalDatum(terrain, auditPoints);
  console.info(
    `[datum] verticalDatum=${datumAudit.verticalDatum} muestras=${datumAudit.samples.length} ` +
      `diff_max=${datumAudit.maxAbsDiffM.toExponential(2)} => ${datumAudit.ok ? 'OK' : 'FALLA'}`,
  );
  console.assert(datumAudit.ok, 'Los dos heightAt NO difieren exactamente en el verticalDatum', datumAudit);
  if (!datumAudit.ok) {
    throw new Error(`Auditoría de datum FALLÓ (diff max ${datumAudit.maxAbsDiffM} m)`);
  }

  let vehicleRef: VehicleRef | null = null;
  let minimap: Minimap | null = null;
  let controls: ReturnType<typeof createVehicleControls> | null = null;
  let player: Player | null = null;
  /** Id del vehículo activo (`estandar` por defecto; `?vehicle=` gana a localStorage). */
  let currentVehicleId: string = DEFAULT_VEHICLE_ID;
  // Selector de vehículo (FASE 2): se crea con el 4x4; el listener de KeyV
  // (registrado arriba) lo usa si ya existe. `null` durante la carga.
  let selectorVehiculo: VehicleSelector | null = null;
  // Atmósfera (niebla + sombras). Se crea al final del bootstrap, cuando ya hay
  // mallas que proyectan; acá se declara porque el cambio de vehículo re-vincula
  // sus casters dentro de `prepareRebind`.
  let atmosphere: Atmosphere | null = null;

  /** Actor activo; `null` durante la carga o en modo cámara libre. */
  const activeVehicle = (): VehicleActor | null => vehicleRef?.current ?? null;

  /** Meshes del actor que proyectan sombra (los bujes son un detalle de llanta). */
  const castersOf = (actor: VehicleActor | null): AbstractMesh[] =>
    actor ? actor.root.getChildMeshes().filter((mesh) => !mesh.name.startsWith('vehicle:hub-cap-')) : [];

  /** Fábrica única de actores: selector, API de depuración y cambio comparten esto. */
  const createActor = (definition: VehicleDefinition, pose: VehiclePose): VehicleActor => {
    const options: CreateVehicleOptions = {
      scene,
      terrain,
      spawn: { x: pose.x, z: pose.z, yaw: pose.yaw },
      ...(controls ? { controls } : {}),
    };
    return createVehicle(options, definition);
  };

  /** Muestreo de huella del destino para las reglas de espacio, agua y bajada. */
  const footprintSamples = (target: VehicleDefinition, pose: VehiclePose): VehiclePose[] => {
    const fx = Math.sin(pose.yaw);
    const fz = Math.cos(pose.yaw);
    const halfLength = target.bodySize.lengthM / 2;
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
  };

  /** Rebinding transaccional: sombras del vehículo + cámara y HUD restaurables. */
  const prepareRebind = (next: VehicleActor, previous: VehicleActor): PreparedRebind => {
    const cameraPosition = camera.position.clone();
    const cameraTarget = camera.target ? camera.target.clone() : null;
    const hudText = hud ? hud.textContent : null;
    const previousCasters = castersOf(previous);
    const nextCasters = castersOf(next);
    const swapCasters = (enable: AbstractMesh[], disable: AbstractMesh[]): void => {
      const generator = atmosphere?.shadowGenerator;
      if (!generator) return;
      for (const mesh of disable) generator.removeShadowCaster(mesh, true);
      for (const mesh of enable) generator.addShadowCaster(mesh, true);
    };
    let applied = false;
    return {
      commit: () => {
        swapCasters(nextCasters, previousCasters);
        applied = true;
      },
      rollback: () => {
        // Idempotente: sólo revierte lo que el commit llegó a aplicar.
        if (applied) swapCasters(previousCasters, nextCasters);
        camera.position.copyFrom(cameraPosition);
        if (cameraTarget) camera.setTarget(cameraTarget);
        if (hud && hudText !== null) hud.textContent = hudText;
        applied = false;
      },
    };
  };

  /**
   * Reglas del mundo para el cambio de vehículo. Esta milestone NO modela colisión
   * con edificios: el espacio se valida contra el claro del repetidor y el terreno;
   * el agua y la bajada usan la huella real del destino.
   */
  const switchContext: SwitchContext = {
    terrain,
    canPlace: (target, pose) => {
      const blockedRadius =
        (objective?.interactable.radiusM ?? FIRST_ROUTE.targetClearRadiusM) +
        Math.max(target.bodySize.lengthM, target.bodySize.widthM) / 2;
      if (Math.hypot(pose.x - FIRST_ROUTE.target.x, pose.z - FIRST_ROUTE.target.z) < blockedRadius) return false;
      return Number.isFinite(terrain.heightAt(pose.x, pose.z));
    },
    waterSafe: (target, pose) => {
      if (!water) return true;
      return footprintSamples(target, pose).every((point) => water!.depthAt(point.x, point.z) <= AGUA_VADEO_M);
    },
    canExit: (target, pose) => {
      const sideX = pose.x + Math.cos(pose.yaw) * target.exitOffsetM;
      const sideZ = pose.z - Math.sin(pose.yaw) * target.exitOffsetM;
      const height = terrain.heightAt(sideX, sideZ);
      const normal = terrain.normalAt(sideX, sideZ);
      if (!Number.isFinite(height) || !Number.isFinite(normal.y) || normal.y < 0.5) return false;
      return !water || water.depthAt(sideX, sideZ) === 0;
    },
    create: createActor,
    prepareRebind,
    persist: (id) => {
      currentVehicleId = id;
      writeStoredVehicleId(id);
      selectorVehiculo?.setCurrent(id);
    },
  };

  /**
   * Cambia al vehículo `id` (si es distinto) por el camino atómico. Devuelve false
   * y deja todo como estaba si el id no existe o la pose de destino es inválida.
   */
  function cambiarVehiculo(id: string): boolean {
    if (!vehicleRef) return false;
    const definition = vehicleById(id);
    if (!definition) {
      selectorVehiculo?.setCurrent(currentVehicleId);
      return false;
    }
    if (definition.id === currentVehicleId) {
      selectorVehiculo?.setCurrent(currentVehicleId);
      return true;
    }
    const result = switchVehicle(vehicleRef, definition, switchContext);
    if (!result.ok) {
      selectorVehiculo?.setCurrent(currentVehicleId);
      return false;
    }
    return true;
  }
  let playerControls: PlayerControls | null = null;
  /** Envoltorio del control del personaje que admite entrada inyectada. */
  let controlsForPlayer: PlayerControls | null = null;
  let manualStep = false;
  /**
   * Un guion de medición tomó el control del vehículo con `setInput`.
   * Sin esta bandera, el personaje pisaría ese input en cada frame y las capturas
   * de la FASE 4 medirían otra cosa que la que creen medir.
   */
  let manualInput = false;
  /**
   * Reposiciona vehículo y personaje en el inicio de la ruta. Se asigna al construir
   * el vehículo, pero se declara acá porque los dos lo usan: el teclado (R) y la API
   * de depuración (`reset`).
   */
  let resetToStart: () => void = () => {};
  let objective: Objective | null = null;
  let mission: Mission | null = null;
  let interactor: Interactor | null = null;
  /** Entrada inyectada por un guion de medición. `null` = manda el teclado. */
  let injected: InjectedInput | null = null;
  /** Último estado de la misión, para que el HUD lo lea sin recalcularlo. */
  let ultimaMision: MissionSnapshot | null = null;
  /** Reglas del agua (AGUA T6 §5.2/§5.3): viven acá, no en `vehicle/physics.ts`. */
  let estadoAgua: EstadoAgua = 'seco';
  /** Cuánto baja el modelo del 4x4 respecto de su pose (solo visual). */
  let caladoAgua = 0;
  /** Tiempo acumulado en la secuencia de hundimiento (§5.3.3). */
  let hundimientoS = 0;
  /** Tiempo sin avanzar con gas en el fango (§5.2). */
  let enfangadoS = 0;
  /** Límite de velocidad objetivo dentro del agua; `Infinity` en seco. */
  let velocidadMaximaAgua = Infinity;
  /** Última posición con profundidad 0: fallback si no hay orilla (§5.3.4). */
  let ultimaPosicionSeca: { x: number; z: number } | null = null;
  let avisoHundidoTimeout: number | undefined = undefined;

  // ----- Capa vial drapeada (FASE 3b) -----
  // `?drape=0` desactiva la red: sirve para medir draw calls/triángulos
  // "antes y después" en la MISMA build (ver scripts/roads/draping).
  const drapeParam = params.get('drape');
  const roadsEnabled = drapeParam === null || !(drapeParam === '0' || drapeParam.toLowerCase() === 'false');
  let roads: RoadNetwork | null = null;
  /** Stats del pueblo cargado (FASE E), para la API de depuración. */
  let villageStats: VillageStats | null = null;
  let landmarks: VillageLandmarks | null = null;
  const landmarksEnabled = params.get('landmarks') !== '0';
  if (landmarksEnabled) {
    try {
      landmarks = await loadVillageLandmarks(scene, terrain, { baseUrl: publicUrl('/village/focal-sites/') });
    } catch (error) {
      console.warn('[hitos] no se pudieron cargar; se mantienen los elementos base', error);
    }
  }
  if (roadsEnabled) {
    // Dominio real del terreno: evita que `heightAt` devuelva el "0 absoluto"
    // (−datum) para vértices laterales que asoman fuera de la ventana.
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const sampler of terrain.samplers) {
      const extent = gridExtent(sampler.grid);
      minX = Math.min(minX, extent.minX);
      maxX = Math.max(maxX, extent.maxX);
      minZ = Math.min(minZ, extent.minZ);
      maxZ = Math.max(maxZ, extent.maxZ);
    }
    roads = await loadRoadNetwork(scene, terrain, {
      url: publicUrl('/roads/roads.json'),
      bounds: { minX, maxX, minZ, maxZ },
      polishTrackAt: { ...FIRST_ROUTE.trackEntry, radiusM: 90 },
      polishRoadAt: { ...FIRST_ROUTE.start, radiusM: 120 },
      // El faldón de mezcla de la pista se dibuja solo a lo largo de la ruta jugable.
      trackBlendCorridor: { points: FIRST_ROUTE.polyline, radiusM: 30 },
    });
    console.info(
      `[vias] ${roads.stats.roads} segmentos · ${roads.stats.vertices} vértices · ` +
        `${roads.stats.triangles} triángulos · ${roads.stats.meshes} mallas · ${roads.stats.bridges} puentes`,
    );
  }

  // ----- Agua decorativa (AGUA T4) -----
  // `?water=0` la apaga, igual que `?drape=0` y `?pueblo=0`: permite medir draw
  // calls y triángulos "con y sin" en la MISMA build, sin tocar código. Se carga
  // DESPUÉS de las vías y es decorativa: si falla, el juego arranca igual.
  const aguaParam = params.get('water');
  const waterEnabled = aguaParam === null || !(aguaParam === '0' || aguaParam.toLowerCase() === 'false');
  let water: Water | null = null;
  if (waterEnabled) {
    try {
      water = await loadWater(scene, terrain, {
        url: publicUrl('/water/water.json'),
        includeDam: !landmarks?.replacesDam,
      });
      console.info(
        `[agua] ${water.stats.sheets} láminas · ${water.stats.ribbons} cintas · ${water.stats.meshes} mallas`,
      );
    } catch (error) {
      water = null; // decorativo: si falla, el juego arranca igual
      console.warn('[agua] no se pudo cargar la capa decorativa', error);
    }
  }

  // ----- Pueblo low-poly (FASE E) -----
  // `?pueblo=0` lo apaga, igual que `?drape=0`: permite medir draw calls y triángulos
  // "con y sin" en la MISMA build, sin tocar una línea de código.
  const puebloParam = params.get('pueblo');
  const villageEnabled = puebloParam === null || !(puebloParam === '0' || puebloParam.toLowerCase() === 'false');
  if (villageEnabled) {
    const start = FIRST_ROUTE.start;
    const roadClearance = roads?.stations()
      .filter((station) => Math.hypot(station.x - start.x, station.z - start.z) <= VILLAGE_ROAD_CLEARANCE_QUERY_RADIUS_M)
      .map((station) => ({
        x: station.x,
        z: station.z,
        radiusM: station.class === 'ROAD' ? 5.2 : station.class === 'TRACK' ? 3.6 : 2.5,
        // La dirección del eje deja que el pueblo oriente los postes perpendiculares.
        dx: station.dx,
        dz: station.dz,
      })) ?? [];
    const village = await loadVillage(scene, terrain, {
      url: publicUrl('/village/buildings.json'),
      buildingHeightGridUrl: publicUrl('/village/building_height_grid.json'),
      pilotAssetUrl: publicUrl('/village/pilot-houses.glb'),
      ...(landmarks ? { omitBuildingIds: landmarks.coveredBuildingIds } : {}),
      keepClearAt: { x: FIRST_ROUTE.start.x, z: FIRST_ROUTE.start.z },
      keepClearRadiusM: 12,
      roadClearance,
    });
    villageStats = village.stats;
    // El módulo ya loguea sus propias cifras al cargar: no se duplican acá.
  }

  // ----- Vegetación procedural (FASE D) -----
  // `?vegetation=0` la apaga, mismo patrón que `?pueblo=0` y `?drape=0`: permite
  // medir draw calls y triángulos "con y sin" en la MISMA build. El corredor y los
  // claros salen de la ruta para que ningún árbol tape la calzada ni el repetidor:
  // es la MISMA red de seguridad que el build ya verifica.
  const vegetacionParam = params.get('vegetation');
  const vegetationEnabled =
    vegetacionParam === null || !(vegetacionParam === '0' || vegetacionParam.toLowerCase() === 'false');
  let vegetation: Vegetation | null = null;
  if (vegetationEnabled) {
    // La vegetación es DECORATIVA: si su carga falla, el juego arranca igual. Por eso
    // el try/catch envuelve SÓLO el await: un fallo de datos no puede tumbar el bootstrap.
    try {
      vegetation = await loadVegetation(scene, terrain, {
        url: publicUrl('/vegetation/vegetation.json'),
        corridors: routeCorridors(FIRST_ROUTE),
        clearings: [
          { x: FIRST_ROUTE.start.x, z: FIRST_ROUTE.start.z, radiusM: 30 },
          { x: FIRST_ROUTE.target.x, z: FIRST_ROUTE.target.z, radiusM: FIRST_ROUTE.targetClearRadiusM },
        ],
      });
    } catch (error: unknown) {
      vegetation = null;
      console.warn(
        `[vegetacion] no se pudo cargar la capa decorativa; se continúa sin ella: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  const groundY = terrain.heightAt(spawnX, spawnZ);

  // ----- Aparición jugable (FASE B) -----
  // El 4x4 aparece en el INICIO DE LA RUTA, no en el centroide del pueblo: el inicio
  // ya cae sobre el asfalto de la N-120 y su guiñada mira a lo largo de la vía, así
  // que el jugador nace mirando a la carretera y no a una tapia.
  // `?vx/?vz/?vyaw` siguen mandando, para las capturas de medición.
  const startX = queryNumber(params, 'vx') ?? FIRST_ROUTE.start.x;
  const startZ = queryNumber(params, 'vz') ?? FIRST_ROUTE.start.z;
  const yaw = queryNumber(params, 'vyaw') ?? FIRST_ROUTE.startYaw;

  if (freeCamera) {
    camera.position = new Vector3(px ?? spawnX, py ?? groundY + 100, pz ?? spawnZ - 40);
    const target = new Vector3(tx ?? spawnX, ty ?? groundY - 15, tz ?? spawnZ + 480);
    camera.setTarget(target);
  } else {
    camera.detachControl();

    // `?player=0` deja el camino legado: sólo 4x4, con sus propios controles. Lo usan
    // los guiones de medición, que manejan el vehículo con la API de depuración.
    const playerEnabled = params.get('player') !== '0';

    // Punto de aparición a pie: AL COSTADO del 4x4, no encima. Si el personaje nace en
    // la misma posición que el auto queda dentro del chasis, y como la cámara a pie va
    // 4,2 m detrás del personaje, el primer plano del juego es el interior del coche.
    // `exitPosition` es la misma función que usa bajarse del vehículo.
    const salidaInicial = exitPosition(startX, startZ, yaw, terrain);

    const resetToStartFn = (): void => {
      manualInput = false;
      manualStep = false;
      const active = activeVehicle();
      active?.setInput(null);
      active?.teleport(startX, startZ, yaw);
      player?.teleport(salidaInicial.x, salidaInicial.z, yaw);
      // La misión TAMBIÉN vuelve a cero. Sin esto, después de reparar podías apretar
      // R — que te devuelve al punto de partida, que es el objetivo del regreso — y
      // COMPLETAR sin conducir la vuelta: un atajo que se saltea media misión.
      mission?.reset();
      // La regla del agua vuelve a cero (ruling del gate de T6): si no, apretar R
      // dentro de la banda de 0,35-1,1 m deja el calado restándose sobre tierra
      // hasta que decae (~0,5-1,8 s).
      estadoAgua = 'seco';
      caladoAgua = 0;
      hundimientoS = 0;
      enfangadoS = 0;
      velocidadMaximaAgua = Infinity;
      ultimaPosicionSeca = { x: startX, z: startZ };
    };
    resetToStart = resetToStartFn;

    if (playerEnabled) {
      // El personaje es el ÚNICO lector de teclado. Cuando conduce, traduce WASD a
      // input del vehículo. Por eso el vehículo no recibe `controls` acá: dos lectores
      // de la misma tecla es exactamente cómo se desincronizan los estados.
      const realControls = createPlayerControls({ onReset: resetToStart });
      playerControls = realControls;
      // Envoltorio: si un guion inyectó entrada, manda esa; si no, el teclado. El
      // personaje no se entera de la diferencia, y por eso medir y jugar recorren el
      // mismo código en vez de dos caminos que se despegan.
      controlsForPlayer = {
        readVehicular: () =>
          injected
            ? {
                throttle: injected.throttle ?? 0,
                steer: injected.steer ?? 0,
                handbrake: injected.handbrake ?? false,
                neutral: injected.neutral ?? false,
              }
            : realControls.readVehicular(),
        readOnFoot: () =>
          injected
            ? { forward: injected.forward ?? 0, strafe: injected.strafe ?? 0, run: injected.run ?? false }
            : realControls.readOnFoot(),
        get interact(): boolean {
          return injected ? injected.interact ?? false : realControls.interact;
        },
        consumeToggle: () => {
          if (injected && injected.toggle) {
            injected = { ...injected, toggle: false };
            return true;
          }
          return injected ? false : realControls.consumeToggle();
        },
        setVirtualKey: (code, pressed) => realControls.setVirtualKey(code, pressed),
        setVirtualAxes: (forward, strafe) => realControls.setVirtualAxes(forward, strafe),
        dispose: () => realControls.dispose(),
      };

      const mobileButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('#mobile-controls [data-code]'));
      const joystick = document.getElementById('mobile-joystick');
      const joystickThumb = document.getElementById('joystick-thumb');
      const releaseMobileButton = (button: HTMLButtonElement): void => {
        realControls.setVirtualKey(button.dataset.code ?? '', false);
        button.classList.remove('is-pressed');
      };
      for (const button of mobileButtons) {
        button.addEventListener('pointerdown', (event) => {
          event.preventDefault();
          realControls.setVirtualKey(button.dataset.code ?? '', true);
          button.classList.add('is-pressed');
          button.setPointerCapture(event.pointerId);
        });
        const release = (event: PointerEvent): void => {
          event.preventDefault();
          releaseMobileButton(button);
        };
        button.addEventListener('pointerup', release);
        button.addEventListener('pointercancel', release);
        button.addEventListener('lostpointercapture', () => releaseMobileButton(button));
      }
      if (joystick && joystickThumb) {
        const DEAD_ZONE = 0.12;
        let joystickPointer: number | null = null;
        const resetJoystick = (): void => {
          joystickPointer = null;
          joystick.style.setProperty('--joy-x', '0px');
          joystick.style.setProperty('--joy-y', '0px');
          realControls.setVirtualAxes(0, 0);
        };
        const updateJoystick = (event: PointerEvent): void => {
          const bounds = joystick.getBoundingClientRect();
          const maxRadius = Math.max(1, bounds.width / 2 - joystickThumb.clientWidth / 2 - 5);
          let dx = (event.clientX - (bounds.left + bounds.width / 2)) / maxRadius;
          let dy = (event.clientY - (bounds.top + bounds.height / 2)) / maxRadius;
          const distance = Math.hypot(dx, dy);
          if (distance > 1) {
            dx /= distance;
            dy /= distance;
          }
          joystick.style.setProperty('--joy-x', `${dx * maxRadius}px`);
          joystick.style.setProperty('--joy-y', `${dy * maxRadius}px`);
          const magnitude = Math.min(1, Math.hypot(dx, dy));
          const adjustedMagnitude = magnitude <= DEAD_ZONE ? 0 : (magnitude - DEAD_ZONE) / (1 - DEAD_ZONE);
          const scale = magnitude === 0 ? 0 : adjustedMagnitude / magnitude;
          realControls.setVirtualAxes(-dy * scale, dx * scale);
        };
        joystick.addEventListener('pointerdown', (event) => {
          event.preventDefault();
          joystickPointer = event.pointerId;
          joystick.setPointerCapture(event.pointerId);
          updateJoystick(event);
        });
        joystick.addEventListener('pointermove', (event) => {
          if (event.pointerId === joystickPointer) updateJoystick(event);
        });
        const releaseJoystick = (event: PointerEvent): void => {
          if (event.pointerId === joystickPointer) resetJoystick();
        };
        joystick.addEventListener('pointerup', releaseJoystick);
        joystick.addEventListener('pointercancel', releaseJoystick);
        joystick.addEventListener('lostpointercapture', releaseJoystick);
        window.addEventListener('blur', resetJoystick);
      }
      window.addEventListener('blur', () => mobileButtons.forEach(releaseMobileButton));
    } else {
      controls = createVehicleControls({ onReset: resetToStart });
    }

    // Vehículo activo inicial: `?vehicle=<id>` gana sobre localStorage; id
    // desconocido → default. El default reproduce exactamente DEFAULT_VEHICLE_PARAMS.
    {
      const wanted = params.get('vehicle') ?? readStoredVehicleId() ?? DEFAULT_VEHICLE_ID;
      currentVehicleId = vehicleById(wanted) ? wanted : DEFAULT_VEHICLE_ID;
      vehicleRef = { current: createActor(vehicleById(currentVehicleId)!, { x: startX, z: startZ, yaw }) };
    }

    // ----- Selector de vehículo (FASE 2: chip + panel de tarjetas) -----
    // Las tarjetas salen del catálogo; elegir pasa por el cambio atómico, persiste
    // y cierra el panel. Si el DOM no trae los elementos, el juego sigue sin selector.
    {
      const panel = document.getElementById('vehiculos-panel');
      const chip = document.getElementById('vehiculo-chip');
      const canvas = document.getElementById('render-canvas');
      if (panel && chip instanceof HTMLButtonElement && canvas) {
        selectorVehiculo = createVehicleSelector({
          panel,
          chip,
          canvas,
          initialId: currentVehicleId,
          onSelect: (id) => {
            if (cambiarVehiculo(id)) selectorVehiculo?.toggle(false);
          },
        });
        // El botón táctil usa click directo: el modelo press-and-hold de
        // `setVirtualKey` no sirve para un conmutador.
        document
          .querySelector<HTMLButtonElement>('#mobile-controls [data-code="KeyV"]')
          ?.addEventListener('click', () => selectorVehiculo?.toggle());
      }
    }

    if (playerEnabled) {
      // Arranca A PIE, al costado del 4x4: el guion de la misión pide entrar al coche.
      // `controls` se OMITE si no hay: con `exactOptionalPropertyTypes` no se puede
      // pasar `undefined` a una propiedad opcional, hay que no ponerla.
      player = createPlayer({
        scene,
        terrain,
        vehicleRef: vehicleRef!,
        spawn: { x: salidaInicial.x, z: salidaInicial.z, yaw },
        ...(controlsForPlayer ? { controls: controlsForPlayer } : {}),
      });
    }

    // ----- Objetivo, interacción y misión (FASES G y H) -----
    // El objetivo vive en el fondo de pista que eligió el generador de la ruta, y el
    // radio de despeje sale de la ruta: así la vegetación y el pueblo no lo tapan.
    objective = createRepeaterObjective(scene, terrain, {
      at: { x: FIRST_ROUTE.target.x, z: FIRST_ROUTE.target.z, yaw: FIRST_ROUTE.targetYaw },
      clearRadiusM: FIRST_ROUTE.targetClearRadiusM,
    });
    interactor = createInteractor([objective.interactable]);
    // El radio de reparación sale del PROPIO repetidor (`radiusM`): el aviso de E y
    // el progreso de la misión no pueden divergir porque son el mismo número.
    mission = createMission(FIRST_ROUTE, { repairRadiusM: objective.interactable.radiusM });

    // Posición de cámara inicial detrás del vehículo.
    camera.position = new Vector3(startX - Math.sin(yaw) * 7.5, terrain.heightAt(startX, startZ) + 2.4, startZ - Math.cos(yaw) * 7.5);
    camera.minZ = 0.3;
  }

  // The minimap is available in normal play and in the free-camera capture mode.
  {
    const mapCanvas = document.getElementById('minimapa-canvas');
    const recenterButton = document.getElementById('minimapa-recenter');
    if (mapCanvas instanceof HTMLCanvasElement) {
      minimap = createMinimap({
        canvas: mapCanvas,
        roads: roads?.mapLines() ?? [],
        route: FIRST_ROUTE.polyline,
        labels: [
          { id: 'santiago', name: 'Iglesia', x: 3067.357, z: 3976.874, kind: 'church' },
          { id: 'plaza', name: 'Plaza', x: 3063.04, z: 4012.346, kind: 'square' },
          { id: 'presa', name: 'Presa de Alba', x: 2434.565, z: 1523.295, kind: 'dam' },
        ],
        ...(recenterButton instanceof HTMLButtonElement ? { recenterButton } : {}),
      });
    }
  }

  // ----- Atmósfera (FASE I): niebla exponencial + sombras -----
  // Se crea ACÁ y no al principio porque necesita las mallas que proyectan (4x4,
  // personaje, repetidor) y las que reciben (terreno, vías): antes de existir no hay
  // nada que anclar al shadow map. El sol conserva la dirección que ya tenía la escena.
  const atmosphereBuilt = createAtmosphere(scene, {
    shadowCasters: [
      // Los bujes son un detalle de llanta; no necesitan emitir sombras propias.
      ...castersOf(activeVehicle()),
      ...(player ? player.root.getChildMeshes() : []),
      ...(objective ? objective.root.getChildMeshes() : []),
    ],
    // Roads and vehicle panels stay unshadowed to avoid PCF acne/green slivers;
    // terrain receives shadows, so the vehicle remains grounded in the scene.
    shadowReceivers: [...terrain.meshes],
  });
  atmosphere = atmosphereBuilt;

  window.addEventListener('resize', () => engine.resize());

  const diagnostics = createDiagnostics(scene);
  let hudTick = 0;

  terrain.cull(camera);

  // ----- Panel de misión -----
  // La estructura se arma UNA vez desde una plantilla constante y después sólo se
  // escriben `textContent`: los datos de la misión no se interpolan en HTML.
  if (misionEl) {
    misionEl.innerHTML =
      '<div class="mision-titulo"></div><div class="mision-estado"></div>' +
      '<div class="mision-pista"></div><div class="mision-progreso" hidden><i></i></div>';
  }
  const misionTitulo = misionEl?.querySelector<HTMLElement>('.mision-titulo') ?? null;
  const misionEstado = misionEl?.querySelector<HTMLElement>('.mision-estado') ?? null;
  const misionPista = misionEl?.querySelector<HTMLElement>('.mision-pista') ?? null;
  const misionProgreso = misionEl?.querySelector<HTMLElement>('.mision-progreso') ?? null;
  const misionBarra = misionEl?.querySelector<HTMLElement>('.mision-progreso > i') ?? null;

  const updateMissionHud = (snap: MissionSnapshot): void => {
    if (!misionEl || !misionTitulo || !misionEstado || !misionPista) return;
    misionEl.hidden = false;
    misionEl.classList.toggle('mision-completada', snap.completed);
    misionTitulo.textContent = MISSION_NAME;

    // La distancia que importa es siempre la del PRÓXIMO paso, no una fija.
    const volviendo = snap.state === 'REPAIRED' || snap.state === 'RETURNING' || snap.completed;
    const metros = volviendo ? snap.distanceToReturnM : snap.distanceToTargetM;
    misionEstado.textContent = `${ETIQUETA_ESTADO[snap.state]} · ${metros.toFixed(0)} m`;
    misionPista.textContent = snap.completed ? `Completada en ${formatMinutos(snap.elapsedS)}` : snap.hint;

    if (misionProgreso && misionBarra) {
      const reparando = snap.repairProgress > 0 && snap.repairProgress < 1;
      misionProgreso.hidden = !reparando;
      misionBarra.style.width = `${Math.round(snap.repairProgress * 100)}%`;
    }
  };

  /**
   * Cámara de persecución. Sigue al 4x4 cuando se conduce y al personaje cuando se va a
   * pie: son dos encuadres distintos porque el ojo está a otra altura y a otra
   * distancia. Con el mismo encuadre, el personaje tapa media pantalla.
   */
  const cameraOccluders = new Set(scene.meshes.filter((mesh) =>
    mesh.isPickable && (
      mesh.name.startsWith('pueblo:cuerpo:') ||
      mesh.name.startsWith('pueblo:tejado:') ||
      mesh.name === 'pueblo:detalle' ||
      mesh.name === 'pueblo:piloto:casas'
    ),
  ));
  const cameraHit = (from: Vector3, to: Vector3) => {
    const offset = to.subtract(from);
    const length = offset.length();
    return length > 0
      ? scene.pickWithRay(
        new Ray(from, offset.scale(1 / length), length),
        (mesh) => cameraOccluders.has(mesh),
      )
      : null;
  };

  const updateChaseCamera = (dt: number): void => {
    const active = activeVehicle();
    if (!active) return;
    const walking = player !== null && player.mode === 'on-foot';

    const yawRad = walking ? (player!.telemetry().yawDeg * Math.PI) / 180 : active.state.yaw;
    const fx = Math.sin(yawRad);
    const fz = Math.cos(yawRad);
    const body = walking ? player!.root.position : active.root.position;

    // En vertical (móvil) el 4x4 tapa media pantalla con el encuadre de escritorio:
    // el encuadre se abre con la relación de aspecto en vez de quedar fijo.
    const aspect = engine.getRenderWidth() / Math.max(1, engine.getRenderHeight());
    const verticalidad = Math.max(0, Math.min(1, (1 - aspect) / 0.55));
    const distance = (walking ? 5.2 : 7.5) * (1 + 0.42 * verticalidad);
    const height = (walking ? 2.1 : 2.4) * (1 + 0.3 * verticalidad);
    const lookAhead = walking ? 1.6 : 1.8;
    const lookHeight = walking ? 1.5 : 0.85;

    const cameraAnchor = new Vector3(body.x, body.y + lookHeight, body.z);
    const desired = new Vector3(body.x - fx * distance, body.y + height, body.z - fz * distance);
    // La pista trepa 21,8°: sin este tope la cámara queda enterrada en la ladera y la
    // pantalla se llena de terreno (la persecución no tiene colisión propia).
    desired.y = Math.max(desired.y, terrain.heightAt(desired.x, desired.z) + 0.7);
    const side = new Vector3(fz, 0, -fx);
    const cameraSight = (candidate: Vector3) => [-1.2, 0, 1.2].map((offset) =>
      cameraHit(cameraAnchor.add(side.scale(offset)), candidate),
    );
    let chosen = desired;
    let hit = cameraHit(cameraAnchor, desired);
    if (hit?.hit) {
      let bestBlockedDistance = hit.distance ?? 0;
      let clear = false;
      const backDistances = [distance, distance * 0.72, distance * 0.48];
      const sideOffsets = [0, -2.5, 2.5, -5, 5, -7.5, 7.5, -10, 10];
      search: for (const backDistance of backDistances) {
        for (const sideOffset of sideOffsets) {
          if (backDistance === distance && sideOffset === 0) continue;
          const candidate = new Vector3(
            body.x - fx * backDistance + side.x * sideOffset,
            body.y + height + (sideOffset === 0 ? 0 : 2),
            body.z - fz * backDistance + side.z * sideOffset,
          );
          candidate.y = Math.max(candidate.y, terrain.heightAt(candidate.x, candidate.z) + 0.7);
          const candidateHits = cameraSight(candidate);
          const blockedHits = candidateHits.filter((candidateHit) => candidateHit?.hit);
          if (blockedHits.length === 0) {
            chosen = candidate;
            hit = null;
            clear = true;
            break search;
          }
          const clearance = Math.min(...blockedHits.map((candidateHit) => candidateHit?.distance ?? 0));
          if (clearance > bestBlockedDistance) {
            bestBlockedDistance = clearance;
            if (candidateHits[1]?.hit) {
              chosen = candidate;
              hit = candidateHits[1];
            }
          }
        }
      }
      if (!clear && hit?.hit && hit.pickedPoint) {
        const offset = chosen.subtract(cameraAnchor);
        const length = offset.length();
        // Never place the camera inside the vehicle while the street is occluded.
        const safeDistance = Math.max(3.2, Vector3.Distance(cameraAnchor, hit.pickedPoint) - 0.45);
        chosen = cameraAnchor.add(offset.scale(safeDistance / length));
      }
    }
    const k = 1 - Math.exp(-dt * (walking ? 7 : 5));
    camera.position = cameraHit(cameraAnchor, camera.position)?.hit
      ? chosen
      : Vector3.Lerp(camera.position, chosen, k);
    // El lerp puede acercar la cámara a una ladera ya atravesada: se sostiene la cota
    // mínima también sobre la pose actual.
    const cotaMinima = terrain.heightAt(camera.position.x, camera.position.z) + 0.5;
    if (camera.position.y < cotaMinima) camera.position.y = cotaMinima;
    camera.setTarget(new Vector3(body.x + fx * lookAhead, body.y + lookHeight, body.z + fz * lookAhead));
  };

  /**
   * Aviso de acción, abajo al centro. Aparece SÓLO cuando hay algo que apretar: un
   * cartel permanente deja de leerse. Al conducir se oculta por encima de 4 m/s
   * porque bajarse en movimiento no es una opción y el cartel sólo tienta.
   */
  const updateActionPrompt = (): void => {
    if (!accionEl) return;
    let aviso = '';
    if (player) {
      const t = player.telemetry();
      if (t.mode === 'on-foot') {
        // El interactuable manda sobre el vehículo: si estás al lado del repetidor,
        // lo que querés es repararlo, no entrar al coche.
        // El repetidor sólo se ofrece mientras la misión espera la reparación. Si no,
        // el aviso de reparar (que gana sobre el de entrar) seguía tapando la "F"
        // justo cuando ya habías reparado y lo que querías era volver al 4x4.
        const alcance =
          interactor && ultimaMision?.state === 'TARGET_REACHED' ? interactor.query(t.x, t.z) : null;
        if (alcance && alcance.available) aviso = AVISO_REPARAR;
        else if (t.canEnter) aviso = AVISO_ENTRAR;
      } else if (Math.abs(t.speedMps) < 4) {
        aviso = AVISO_BAJAR;
      }
    }
    if (aviso === '') {
      accionEl.hidden = true;
    } else {
      accionEl.innerHTML = aviso;
      accionEl.hidden = false;
    }
  };

  const TECLAS_CONDUCIENDO =
    'W/S acelerar-frenar · A/D girar · Espacio freno de mano · N punto muerto · F bajar del 4x4 · V vehículo · R reiniciar misión';
  const TECLAS_A_PIE = 'WASD/flechas caminar · Shift correr · F entrar al 4x4 · V vehículo · R reiniciar misión';

  /**
   * Nivel de gas actual en conducción, para la regla de enfangado. Lee el mismo
   * control que mueve al 4x4 (inyectado o teclado): es una lectura pura.
   */
  const leerGasConduciendo = (): number => {
    if (controlsForPlayer) return controlsForPlayer.readVehicular().throttle;
    if (controls) return controls.read().throttle;
    return 0;
  };

  /** Muestra el aviso de rescate ~4 s. El juego no se pausa (§5.3.3). */
  const mostrarAvisoHundido = (): void => {
    if (!avisoEl) return;
    avisoEl.textContent = AVISO_HUNDIDO;
    avisoEl.hidden = false;
    if (avisoHundidoTimeout !== undefined) window.clearTimeout(avisoHundidoTimeout);
    avisoHundidoTimeout = window.setTimeout(() => {
      if (avisoEl) avisoEl.hidden = true;
      avisoHundidoTimeout = undefined;
    }, AVISO_HUNDIDO_MS);
  };

  /** Teleport a la orilla segura, velocidad 0 y calado 0 (§5.3.3/§5.3.4). */
  const volverALaOrilla = (): void => {
    const active = activeVehicle();
    if (!water || !active) return;
    const destino = water.nearestSafeShore(active.state.x, active.state.z) ?? ultimaPosicionSeca;
    if (destino) {
      // En conducción el teleport pasa por el jugador para que personaje y 4x4
      // sigan siendo una sola posición; si no, directo al vehículo.
      if (player && player.mode === 'driving') player.teleport(destino.x, destino.z, active.state.yaw);
      else active.teleport(destino.x, destino.z, active.state.yaw);
      ultimaPosicionSeca = { x: destino.x, z: destino.z };
    } else {
      // Sin punto seguro ni última posición seca: se detiene acá (§5.3.4 pide
      // nunca bloquear; el próximo frame lo vuelve a intentar).
      active.state.speed = 0;
      active.state.lateral = 0;
      active.applyPose();
    }
    caladoAgua = 0;
    hundimientoS = 0;
    enfangadoS = 0;
    velocidadMaximaAgua = Infinity;
    estadoAgua = 'seco';
    mostrarAvisoHundido();
  };

  /**
   * Reglas del agua (AGUA §5.2/§5.3). Solo en conducción: a pie el agua es
   * decorativa. No toca la física (`vehicle/physics.ts` intacto): limita la
   * velocidad objetivo post-paso y aplica un offset visual al modelo.
   * Con `?water=0` (o si falló la carga) no hay reglas ni aviso.
   */
  const reglasAgua = (dt: number): void => {
    const active = activeVehicle();
    if (!water || !active) {
      estadoAgua = 'seco';
      return;
    }
    if (player && player.mode !== 'driving') {
      estadoAgua = 'seco';
      hundimientoS = 0;
      enfangadoS = 0;
      velocidadMaximaAgua = Infinity;
      caladoAgua = Math.max(0, caladoAgua - dt * 0.8);
      return;
    }
    const x = active.state.x;
    const z = active.state.z;
    const prof = water.depthAt(x, z);
    if (prof === 0) ultimaPosicionSeca = { x, z };
    const velocidad = Math.abs(active.state.speed);
    const gas = leerGasConduciendo();

    if (water.isMuddy(x, z) && velocidad < AGUA_ENFANGADO_VELOCIDAD_MPS && gas > 0) enfangadoS += dt;
    else enfangadoS = 0;

    if (prof > AGUA_HUNDIMIENTO_M || enfangadoS > AGUA_ENFANGADO_S) {
      // Secuencia de hundimiento (§5.3): se atenúa el control (solo límite de
      // velocidad, sin fuerzas nuevas) y crece el calado visual; a los ~1,5 s
      // vuelve a la orilla. El tope se fija acá también para el caso de entrar
      // directo a >1,1 m sin haber pasado por la banda de arrastre (gate T6).
      velocidadMaximaAgua = AGUA_VELOCIDAD_ARRASTRE_MPS;
      estadoAgua = prof > AGUA_HUNDIMIENTO_M ? 'hundiendo' : 'enfangado';
      hundimientoS += dt;
      caladoAgua = Math.min(AGUA_CALADO_MAX_M, caladoAgua + dt * 1.2);
      if (hundimientoS > AGUA_HUNDIMIENTO_S) volverALaOrilla();
    } else {
      hundimientoS = 0;
      if (prof > AGUA_VADEO_M) {
        estadoAgua = 'arrastrando';
        velocidadMaximaAgua = AGUA_VELOCIDAD_ARRASTRE_MPS;
      } else if (prof > 0) {
        estadoAgua = 'vadeando';
        velocidadMaximaAgua = AGUA_VELOCIDAD_VADEO_MPS;
      } else {
        estadoAgua = 'seco';
        velocidadMaximaAgua = Infinity;
      }
      // El calado visual sigue a la profundidad con tope de 1,5 m (§5.2/§5.3.2).
      const objetivo = Math.min(AGUA_CALADO_MAX_M, prof);
      if (caladoAgua < objetivo) caladoAgua = Math.min(objetivo, caladoAgua + dt * 1.2);
      else caladoAgua = Math.max(objetivo, caladoAgua - dt * 0.8);
    }

    // Límite de velocidad objetivo post-paso, sin tocar la física.
    if (velocidadMaximaAgua < Infinity) {
      if (active.state.speed > velocidadMaximaAgua) active.state.speed = velocidadMaximaAgua;
      else if (active.state.speed < -velocidadMaximaAgua) active.state.speed = -velocidadMaximaAgua;
    }
    // Calado visual: el modelo baja respecto de su pose; la física no cambia.
    if (caladoAgua > 0) active.root.position.y -= caladoAgua;
  };

  /**
   * Un paso de simulación coherente: primero el mundo (personaje o vehículo) y después
   * la misión, con el estado YA actualizado.
   *
   * Es una sola función y no dos bloques sueltos porque el arnés avanza por acá: si la
   * misión se actualizara sólo dentro del render loop, un paso determinista mediría un
   * mundo que no avanzó y el arnés estaría midiendo otra cosa que el juego.
   */
  const stepSimulation = (dt: number): void => {
    // La F se consume ACÁ. El personaje expone `toggleVehicle()` y el control expone
    // `consumeToggle()`, pero si el loop no los une, nadie los une: la tecla levanta el
    // flanco, queda pendiente para siempre y apretar F NO HACE NADA. Eso compila, pasa el
    // typecheck y no rompe ningún test, porque el cable que falta no lo ve nadie.
    // Se consume SIEMPRE (aunque no puedas entrar), para que un F apretado lejos no quede
    // guardado y dispare solo cuando te acercás.
    if (player && controlsForPlayer?.consumeToggle()) player.toggleVehicle();

    const active = activeVehicle();
    if (player) {
      player.step(dt);
      // Bajarse con el 4x4 en movimiento NO lo congela: sigue rodando sin input y
      // frena solo. Congelado, volver a subir devolvía intacta la velocidad guardada
      // — o sea, salir del coche era un freno instantáneo y entrar, un teletransporte.
      if (player.mode === 'on-foot' && active && Math.abs(active.telemetry().speed) > 0.05) {
        active.step(dt);
      }
    } else if (active) {
      active.step(dt);
    }

    // Reglas del agua (AGUA §5): post-paso, con el mundo ya avanzado. El `dt` se
    // topa como el de la misión: un frame largo no puede hundir de un golpe.
    reglasAgua(Math.min(dt, 0.1));

    if (!player || !mission) return;
    const t = player.telemetry();
    ultimaMision = mission.update({
      x: t.x,
      z: t.z,
      onFoot: t.mode === 'on-foot',
      driving: t.mode === 'driving',
      interact: t.interact,
      // El `dt` del navegador se dispara al volver de una pestaña en segundo plano.
      // Sin tope, un frame de 5 s completaba la reparación de un solo golpe: el
      // personaje mueve el mundo con el `dt` topado, la misión tiene que ver el mismo.
      dt: Math.min(dt, 0.1),
    });
    objective?.setRepairProgress(ultimaMision.repairProgress);
  };

  engine.runRenderLoop(() => {
    const dt = engine.getDeltaTime() / 1000;
    const active = activeVehicle();
    // Tres caminos, en este orden y no en otro:
    //  1. `manualStep`: el guion ya avanzó el mundo con `step()`.
    //  2. `manualInput`: el guion manda el vehículo con `setInput`; el personaje no
    //     debe pisarlo. La misión no avanza: ese camino es el legado de medición.
    //  3. El jugador, que resuelve a pie o conduciendo.
    if (!manualStep) {
      if (manualInput && active) {
        active.step(dt);
        reglasAgua(Math.min(dt, 0.1));
      } else if (player || active) stepSimulation(dt);
    }
    // La cámara de persecución NO se toca en modo cámara libre: si se deja correr,
    // reencuadra al jugador en el primer frame y las capturas de medición salen con la
    // vista del juego (silenciosamente) en vez de la pedida por ?px/py/pz.
    if (!freeCamera) updateChaseCamera(dt);
    if (minimap) {
      const walking = player !== null && player.mode === 'on-foot';
      const body = walking ? player!.root.position : active?.root.position ?? { x: startX, z: startZ };
      if (body) {
        const headingRad = walking
          ? ((player!.telemetry().yawDeg * Math.PI) / 180)
          : (active?.state.yaw ?? yaw);
        minimap.update({ x: body.x, z: body.z, headingRad });
      }
    }
    // El shadow map sigue al jugador: con el ancla fija en el origen, la sombra se
    // cortaba a 100 m y el 4x4 dejaba de proyectar apenas te alejabas del spawn.
    const anclaSombra = player ? player.root.position : active?.root.position;
    if (anclaSombra) atmosphereBuilt.follow(anclaSombra.x, anclaSombra.z);
    terrain.cull(camera);
    // El LOD se recalcula con la cámara YA movida por la persecución y antes de
    // dibujar: al revés, la vegetación vería la pose del frame anterior.
    vegetation?.update(camera.position);
    scene.render();
    hudTick++;
    if (hudTick % 5 === 0) {
      updateActionPrompt();
      if (ultimaMision) updateMissionHud(ultimaMision);
      if (hud && !hud.hidden) {
        const perf = formatSnapshot(diagnostics.snapshot(), terrain);
        const veh = active ? formatActorHud(active) : '';
        const jug = player ? formatPlayerHud(player.telemetry()) : '';
        hud.textContent = [perf, veh, jug].filter((block) => block.length > 0).join('\n\n');
      }
      // Las teclas van en su propio bloque y NO dentro del diagnóstico: en modo cámara
      // libre son otras, y decir las teclas equivocadas es peor que no decir ninguna.
      if (controlsEl) {
        // La ayuda completa (teclas y panel) sólo aparece con F3; en estado normal
        // queda la pista compacta para no ensuciar la vista de juego.
        controlsEl.textContent = ayudaVisible
          ? (player
              ? player.mode === 'driving'
                ? TECLAS_CONDUCIENDO
                : TECLAS_A_PIE
              : active
                ? TECLAS_CONDUCIENDO
                : CONTROLES_LIBRE) + ' · F3 ocultar ayuda'
          : PISTA_AYUDA;
      }
    }
  });

  // ----- API de medición (CDP / capturas) -----
  const debugVehicle = vehicleRef
    ? {
        telemetry: () => vehicleRef!.current.telemetry(),
        category: () => vehicleRef!.current.category,
        setInput: (input: VehicleInput | null) => {
          manualInput = input !== null;
          vehicleRef!.current.setInput(input);
        },
        teleport: (x: number, z: number, yaw: number) => vehicleRef!.current.teleport(x, z, yaw),
        setState: (partial: Partial<{ x: number; z: number; yaw: number; speed: number; lateral: number }>) => {
          const s = vehicleRef!.current.state;
          if (partial.x !== undefined) s.x = partial.x;
          if (partial.z !== undefined) s.z = partial.z;
          if (partial.yaw !== undefined) s.yaw = partial.yaw;
          if (partial.speed !== undefined) s.speed = partial.speed;
          if (partial.lateral !== undefined) s.lateral = partial.lateral;
          vehicleRef!.current.applyPose();
        },
        setParams: (partial: Partial<VehicleParams>) => {
          const active = vehicleRef!.current;
          if (!isFourWheel(active)) return false;
          Object.assign(active.params, partial);
          return true;
        },
        params: () => {
          const active = vehicleRef!.current;
          return isFourWheel(active) ? { ...active.params } : null;
        },
        preset: () => currentVehicleId,
        setPreset: (id: string) => cambiarVehiculo(id),
        recover: () => {
          const active = vehicleRef!.current as VehicleActor & { recover?: () => boolean };
          return active.recover ? active.recover() : false;
        },
        step: (seconds: number, dt = 1 / 60) => {
          manualStep = true;
          const steps = Math.max(1, Math.round(seconds / dt));
          for (let i = 0; i < steps; i++) vehicleRef!.current.step(dt);
        },
        reset: () => resetToStart(),
      }
    : null;

  window.__game = {
    terrainHeightAt: (x, z) => terrain.heightAt(x, z),
    terrainNormalAt: (x, z) => {
      const n = terrain.normalAt(x, z);
      return { x: n.x, y: n.y, z: n.z };
    },
    perf: () => diagnostics.snapshot(),
    auditDatum: () => ({
      verticalDatum: datumAudit.verticalDatum,
      maxAbsDiffM: datumAudit.maxAbsDiffM,
      ok: datumAudit.ok,
      samples: datumAudit.samples,
    }),
    vehicle: debugVehicle,
    roads: roads
      ? {
          stats: () => roads!.stats,
          audit: () => roads!.audit(),
          probe: (count: number) => roads!.probe(count),
          stations: () => roads!.stations(),
        }
      : null,
    route: FIRST_ROUTE,
    water: water
      ? {
          stats: () => water!.stats,
          depthAt: (x: number, z: number) => water!.depthAt(x, z),
          isMuddy: (x: number, z: number) => water!.isMuddy(x, z),
          nearestSafeShore: (x: number, z: number) => water!.nearestSafeShore(x, z),
          estadoAgua: () => estadoAgua,
          calado: () => caladoAgua,
        }
      : null,
    village: villageStats ? { stats: () => villageStats! } : null,
    vegetation: vegetation ? { stats: () => vegetation!.stats } : null,
    player: player
      ? {
          mode: () => player!.mode,
          telemetry: () => player!.telemetry(),
          toggleVehicle: () => player!.toggleVehicle(),
          teleport: (x: number, z: number, ya: number) => player!.teleport(x, z, ya),
          /**
           * Inyecta entrada en vez de teclearla. `null` devuelve el control al teclado.
           * Es lo que permite que el arnés juegue solo: sin esto la validación en
           * navegador no sería automatizable.
           */
          inject: (input: InjectedInput | null) => {
            injected = input;
          },
          /**
           * Paso determinista: avanza el mundo Y la misión con el mismo `dt`, igual que
           * el render loop. Un arnés que avanzara sólo el vehículo mediría una misión
           * que no avanzó.
           */
          step: (seconds: number, dt = 1 / 60) => {
            manualStep = true;
            const steps = Math.max(1, Math.round(seconds / dt));
            for (let i = 0; i < steps; i++) stepSimulation(dt);
          },
        }
      : null,
    mission: mission
      ? {
          name: MISSION_NAME,
          snapshot: () => mission!.snapshot,
          reset: () => {
            mission!.reset();
            ultimaMision = null;
            objective?.setRepairProgress(0);
          },
        }
      : null,
  };

  // Mundo listo: recién acá se libera el cartel de carga (queda abierto si lo pidió
  // `?debug=1`, F3 o el modo medición).
  if (hud && !ayudaVisible) hud.hidden = true;

  window.addEventListener('beforeunload', () => {
    playerControls?.dispose();
    player?.dispose();
    objective?.dispose();
    controls?.dispose();
    activeVehicle()?.dispose();
    minimap?.dispose();
    roads?.dispose();
    water?.dispose();
    landmarks?.dispose();
    vegetation?.dispose();
    diagnostics.dispose();
    terrain.dispose();
    engine.dispose();
  });
}

bootstrap().catch((error: unknown) => {
  showError(error instanceof Error ? error.message : String(error));
});
