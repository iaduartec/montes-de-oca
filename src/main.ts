import { Engine } from '@babylonjs/core/Engines/engine';
import { Scene } from '@babylonjs/core/scene';
import { UniversalCamera } from '@babylonjs/core/Cameras/universalCamera';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { Color4 } from '@babylonjs/core/Maths/math.color';
import { loadTerrainConfig, TERRAIN_CONFIG_PATH, wgs84ToWorld } from './config';
import { publicUrl } from './public-url';
import { createDiagnostics, formatVehicleHud, type DiagnosticsSnapshot } from './diagnostics';
import { auditVerticalDatum, loadTerrain, type WorldTerrain } from './terrain';
import { gridExtent } from './heightfield';
import { loadVillage, type VillageStats } from './environment/village';
import {
  loadVegetation,
  type Vegetation,
  type VegetationCorridor,
  type VegetationStats,
} from './environment/vegetation';
import { createAtmosphere } from './environment/atmosphere';
import {
  loadRoadNetwork,
  type RoadAuditReport,
  type RoadDrapingStats,
  type RoadNetwork,
  type RoadProbe,
  type RoadStation,
} from './road-draping';
import { createVehicle, type Vehicle, type VehicleTelemetry } from './vehicle/index';
import { createVehicleControls } from './vehicle/controls';
import type { VehicleInput, VehicleParams } from './vehicle/physics';
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
const controlsEl = document.getElementById('controls');

/** Teclas del modo cámara libre: es el texto que ya trae `index.html`. */
const CONTROLES_LIBRE =
  'WASD/flechas: mover · Mouse: mirar · Clic en el canvas para capturar el puntero · Shift: acelerar';

/**
 * Avisos de acción. Son constantes cerradas a propósito: se escriben con
 * `innerHTML` para poder usar `<kbd>`, y sin interpolación no hay superficie de
 * inyección. Si algún día el texto depende de datos, hay que cambiar a nodos.
 */
const AVISO_ENTRAR = '<kbd>F</kbd> — entrar al 4x4';
const AVISO_BAJAR = '<kbd>F</kbd> — bajar del 4x4';
const AVISO_REPARAR = '<kbd>E</kbd> — mantener para restablecer el enlace';

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
    telemetry(): VehicleTelemetry;
    setInput(input: VehicleInput | null): void;
    teleport(x: number, z: number, yaw: number): void;
    setState(partial: Partial<{ x: number; z: number; yaw: number; speed: number; lateral: number }>): void;
    setParams(partial: Partial<VehicleParams>): void;
    params(): VehicleParams;
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
  const config = await loadTerrainConfig(fetch, publicUrl(TERRAIN_CONFIG_PATH));
  const terrain = await loadTerrain(scene, {
    ...config,
    tiles: config.tiles.map((tile) => ({ ...tile, url: publicUrl(tile.url) })),
  });

  const params = new URLSearchParams(window.location.search);
  if (hud) {
    hud.hidden = params.get('debug') !== '1';
    window.addEventListener('keydown', (event) => {
      if (event.code !== 'F3') return;
      event.preventDefault();
      hud.hidden = !hud.hidden;
    });
  }

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

  let vehicle: Vehicle | null = null;
  let controls: ReturnType<typeof createVehicleControls> | null = null;
  let player: Player | null = null;
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

  // ----- Capa vial drapeada (FASE 3b) -----
  // `?drape=0` desactiva la red: sirve para medir draw calls/triángulos
  // "antes y después" en la MISMA build (ver scripts/roads/draping).
  const drapeParam = params.get('drape');
  const roadsEnabled = drapeParam === null || !(drapeParam === '0' || drapeParam.toLowerCase() === 'false');
  let roads: RoadNetwork | null = null;
  /** Stats del pueblo cargado (FASE E), para la API de depuración. */
  let villageStats: VillageStats | null = null;
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
    });
    console.info(
      `[vias] ${roads.stats.roads} segmentos · ${roads.stats.vertices} vértices · ` +
        `${roads.stats.triangles} triángulos · ${roads.stats.meshes} mallas · ${roads.stats.bridges} puentes`,
    );
  }

  // ----- Pueblo low-poly (FASE E) -----
  // `?pueblo=0` lo apaga, igual que `?drape=0`: permite medir draw calls y triángulos
  // "con y sin" en la MISMA build, sin tocar una línea de código.
  const puebloParam = params.get('pueblo');
  const villageEnabled = puebloParam === null || !(puebloParam === '0' || puebloParam.toLowerCase() === 'false');
  if (villageEnabled) {
    const start = FIRST_ROUTE.start;
    const roadClearance = roads?.stations()
      .filter((station) => Math.hypot(station.x - start.x, station.z - start.z) <= 130)
      .map((station) => ({
        x: station.x,
        z: station.z,
        radiusM: station.class === 'ROAD' ? 5.2 : station.class === 'TRACK' ? 3.6 : 2.5,
      })) ?? [];
    const village = await loadVillage(scene, terrain, {
      url: publicUrl('/village/buildings.json'),
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
      vehicle?.setInput(null);
      vehicle?.teleport(startX, startZ, yaw);
      player?.teleport(salidaInicial.x, salidaInicial.z, yaw);
      // La misión TAMBIÉN vuelve a cero. Sin esto, después de reparar podías apretar
      // R — que te devuelve al punto de partida, que es el objetivo del regreso — y
      // COMPLETAR sin conducir la vuelta: un atajo que se saltea media misión.
      mission?.reset();
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
        dispose: () => realControls.dispose(),
      };
    } else {
      controls = createVehicleControls({ onReset: resetToStart });
    }

    vehicle = createVehicle({
      scene,
      terrain,
      spawn: { x: startX, z: startZ, yaw },
      controls: controls ?? undefined,
    });

    if (playerEnabled) {
      // Arranca A PIE, al costado del 4x4: el guion de la misión pide entrar al coche.
      // `controls` se OMITE si no hay: con `exactOptionalPropertyTypes` no se puede
      // pasar `undefined` a una propiedad opcional, hay que no ponerla.
      player = createPlayer({
        scene,
        terrain,
        vehicle,
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

  // ----- Atmósfera (FASE I): niebla exponencial + sombras -----
  // Se crea ACÁ y no al principio porque necesita las mallas que proyectan (4x4,
  // personaje, repetidor) y las que reciben (terreno, vías): antes de existir no hay
  // nada que anclar al shadow map. El sol conserva la dirección que ya tenía la escena.
  const atmosphere = createAtmosphere(scene, {
    shadowCasters: [
      ...(vehicle ? vehicle.root.getChildMeshes() : []),
      ...(player ? player.root.getChildMeshes() : []),
      ...(objective ? objective.root.getChildMeshes() : []),
    ],
    shadowReceivers: [...terrain.meshes, ...(roads ? roads.meshes : [])],
  });

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
  const updateChaseCamera = (dt: number): void => {
    if (!vehicle) return;
    const walking = player !== null && player.mode === 'on-foot';

    const yawRad = walking ? (player!.telemetry().yawDeg * Math.PI) / 180 : vehicle.state.yaw;
    const fx = Math.sin(yawRad);
    const fz = Math.cos(yawRad);
    const body = walking ? player!.root.position : vehicle.root.position;

    const distance = walking ? 4.2 : 7.5;
    const height = walking ? 2.1 : 2.4;
    const lookAhead = walking ? 1.6 : 1.8;
    const lookHeight = walking ? 1.5 : 0.85;

    const desired = new Vector3(body.x - fx * distance, body.y + height, body.z - fz * distance);
    const k = 1 - Math.exp(-dt * (walking ? 7 : 5));
    camera.position = Vector3.Lerp(camera.position, desired, k);
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
    'W/S acelerar-frenar · A/D girar · Espacio freno de mano · N punto muerto · F bajar del 4x4 · R reiniciar misión';
  const TECLAS_A_PIE = 'WASD/flechas caminar · Shift correr · F entrar al 4x4 · R reiniciar misión';

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

    if (player) {
      player.step(dt);
      // Bajarse con el 4x4 en movimiento NO lo congela: sigue rodando sin input y
      // frena solo. Congelado, volver a subir devolvía intacta la velocidad guardada
      // — o sea, salir del coche era un freno instantáneo y entrar, un teletransporte.
      if (player.mode === 'on-foot' && vehicle && Math.abs(vehicle.telemetry().speed) > 0.05) {
        vehicle.step(dt);
      }
    } else if (vehicle) {
      vehicle.step(dt);
    }

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
    // Tres caminos, en este orden y no en otro:
    //  1. `manualStep`: el guion ya avanzó el mundo con `step()`.
    //  2. `manualInput`: el guion manda el vehículo con `setInput`; el personaje no
    //     debe pisarlo. La misión no avanza: ese camino es el legado de medición.
    //  3. El jugador, que resuelve a pie o conduciendo.
    if (!manualStep) {
      if (manualInput && vehicle) vehicle.step(dt);
      else if (player || vehicle) stepSimulation(dt);
    }
    updateChaseCamera(dt);
    // El shadow map sigue al jugador: con el ancla fija en el origen, la sombra se
    // cortaba a 100 m y el 4x4 dejaba de proyectar apenas te alejabas del spawn.
    const anclaSombra = player ? player.root.position : vehicle?.root.position;
    if (anclaSombra) atmosphere.follow(anclaSombra.x, anclaSombra.z);
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
        const veh = vehicle ? formatVehicleHud(vehicle.telemetry()) : '';
        const jug = player ? formatPlayerHud(player.telemetry()) : '';
        hud.textContent = [perf, veh, jug].filter((block) => block.length > 0).join('\n\n');
      }
      // Las teclas van en su propio bloque y NO dentro del diagnóstico: en modo cámara
      // libre son otras, y decir las teclas equivocadas es peor que no decir ninguna.
      if (controlsEl) {
        controlsEl.textContent = (player
          ? player.mode === 'driving'
            ? TECLAS_CONDUCIENDO
            : TECLAS_A_PIE
          : vehicle
            ? TECLAS_CONDUCIENDO
            : CONTROLES_LIBRE) + ' · F3 diagnóstico';
      }
    }
  });

  // ----- API de medición (CDP / capturas) -----
  const debugVehicle = vehicle
    ? {
        telemetry: () => vehicle!.telemetry(),
        setInput: (input: VehicleInput | null) => {
          manualInput = input !== null;
          vehicle!.setInput(input);
        },
        teleport: (x: number, z: number, yaw: number) => vehicle!.teleport(x, z, yaw),
        setState: (partial: Partial<{ x: number; z: number; yaw: number; speed: number; lateral: number }>) => {
          const s = vehicle!.state;
          if (partial.x !== undefined) s.x = partial.x;
          if (partial.z !== undefined) s.z = partial.z;
          if (partial.yaw !== undefined) s.yaw = partial.yaw;
          if (partial.speed !== undefined) s.speed = partial.speed;
          if (partial.lateral !== undefined) s.lateral = partial.lateral;
          vehicle!.applyPose();
        },
        setParams: (partial: Partial<VehicleParams>) => Object.assign(vehicle!.params, partial),
        params: () => ({ ...vehicle!.params }),
        step: (seconds: number, dt = 1 / 60) => {
          manualStep = true;
          const steps = Math.max(1, Math.round(seconds / dt));
          for (let i = 0; i < steps; i++) vehicle!.step(dt);
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

  window.addEventListener('beforeunload', () => {
    playerControls?.dispose();
    player?.dispose();
    objective?.dispose();
    controls?.dispose();
    vehicle?.dispose();
    roads?.dispose();
    vegetation?.dispose();
    diagnostics.dispose();
    terrain.dispose();
    engine.dispose();
  });
}

bootstrap().catch((error: unknown) => {
  showError(error instanceof Error ? error.message : String(error));
});
