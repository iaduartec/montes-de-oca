/**
 * FASE I — Atmósfera mínima: niebla exponencial + UN generador de sombras.
 *
 * Este archivo es el ÚNICO que crea las luces de la escena. `src/main.ts` tenía
 * `HemisphericLight` + `DirectionalLight` suelto; acá se centralizan con los MISMOS
 * valores (intensidad, colores, dirección) para que el orquestador borre los de
 * `main.ts` y no queden dos juegos de luces sumando. NO se duplica nada: se mueve.
 *
 * DECISIONES (con números, no con gusto):
 *
 *  1. NIEBLA EXP2 con densidad 2,5·10⁻⁴. La fórmula que usa Babylon es
 *     `visibilidad(d) = exp(−(densidad·d)²)` (ShadersInclude/fogFragmentDeclaration).
 *     Es una niebla SUAVE a propósito: la ventana es de 6.000 m y una bruma
 *     agresiva borra la ruta antes de que se vea el repetidor.
 *       · objetivo a 2.169 m del spawn (verificado por el validador) → 74,5 % visible
 *       · borde del viewRadius (900 m)                                  → 95,1 % visible
 *       · esquina lejana de la ventana (4.243 m)                        → 32,5 % visible
 *       · diagonal de la ventana (8.485 m)                              →  1,1 % visible
 *     Es decir: el horizonte más lejano del mundo se pierde a ~8,6 km (visibilidad
 *     1 %), que está FUERA de la ventana jugable. Profundidad sí, muro de niebla no.
 *     `dense` dobla la densidad (5·10⁻⁴) para la prueba A/B.
 *     El color de niebla es el MISMO que `scene.clearColor`, así el terreno lejano
 *     se funde con el cielo en vez de cortarse contra él.
 *
 *  2. UN ShadowGenerator sobre el sol, de 1024², con PCF y calidad LOW. Sin sombras
 *     por malla, sin SSAO, sin postprocess, sin node materials. El terreno (36 tiles)
 *     RECIBE y NUNCA proyecta: sólo entran al render list los `shadowCasters`.
 *
 *  3. FRUSTUM FIJO + `follow(x, z)`. Con `shadowFrustumSize` fijo el mapa cubre un
 *     cuadrado de 2·R = 200 m centrado en el jugador (radio R = 100 m), en vez de
 *     auto-ajustarse a TODOS los casters (si los árboles son miles, eso distribuye
 *     1024 téxeles sobre kilómetros). Resolución: 200/1024 = 0,195 m/téxel: ~23
 *     téxeles sobre un 4x4 de 4,5 m.
 *     ¿Por qué 100 m? Dos razones:
 *       a) el sol está a 60,3° de elevación, así que un árbol de 10 m proyecta una
 *          sombra de sólo ~5,7 m: sólo importa lo que está cerca.
 *       b) el offset vertical en espacio de luz. `follow` sólo recibe (x, z), así que
 *          la posición Y del sol se ancla en el punto medio del rango del mundo. El
 *          DEM va de 870 a 1194 m absolutos (budget.json) y el datum es 870 → Y de
 *          mundo ∈ [0, 324]. Anclando en 162 el peor corrimiento vertical es
 *          |Δy|·√(1−dirY²) = 162 · 0,4953 = 80,2 m < 100 m. El jugador siempre queda
 *          DENTRO del radio declarado, con 20 % de margen.
 *     La posición del sol es `ancla − dirección·250 m`; el punto del jugador cae
 *     sobre el eje de la vista (offset perpendicular 0) y por eso el mapa queda
 *     centrado en él.
 *
 *  4. sin acne ni peter-panning: `bias = 5·10⁻⁵` (con el rango de profundidad
 *     [40, 450] m eso son ~2,5 cm normalizados) y `normalBias = 0,03` (3 cm en
 *     mundo, sobre la normal y proporcional al ángulo luz/normal, que es lo que
 *     evita el acne en pendientes). El terreno no es caster, así que el bias se
 *     elige por el auto/árboles y priorizando que la sombra no se despegue.
 *
 * Convenciones del proyecto: imports POR MÓDULO, jamás `from '@babylonjs/core'`.
 * `exactOptionalPropertyTypes`: no se construyen propiedades opcionales con
 * `undefined` explícito.
 */

import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight';
import { ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator';
// Efecto de lado OBLIGATORIO. Sin este import, Babylon tira "ShadowGeneratorSceneComponent
// needs to be imported before as it contains a side-effect required by your code" al
// construir el generador, y con eso se cae el bootstrap ENTERO (el juego no arranca).
// Los imports por módulo no arrastran los componentes de escena: hay que pedirlos.
import '@babylonjs/core/Lights/Shadows/shadowGeneratorSceneComponent';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import { HDRCubeTexture } from '@babylonjs/core/Materials/Textures/hdrCubeTexture';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { Texture } from '@babylonjs/core/Materials/Textures/texture';
import { CreateBox } from '@babylonjs/core/Meshes/Builders/boxBuilder';
import { Scene } from '@babylonjs/core/scene';
import type { Mesh } from '@babylonjs/core/Meshes/mesh';
import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh';

/* ------------------------------------------------------------------------- *
 * API pública (la cabla el orquestador tal cual)
 * ------------------------------------------------------------------------- */

export interface AtmosphereOptions {
  /** Meshes que proyectan sombra: el 4x4, el personaje, el objetivo, los árboles. */
  shadowCasters?: AbstractMesh[];
  /** Meshes que reciben sombra: normalmente el terreno. */
  shadowReceivers?: AbstractMesh[];
  /** Niebla más densa (para pruebas A/B). */
  dense?: boolean;
  /** URL pública del HDRI, con BASE_URL aplicado por el bootstrap. */
  environmentUrl?: string;
}

export interface Atmosphere {
  readonly sun: DirectionalLight;
  readonly ambient: HemisphericLight;
  readonly shadowGenerator: ShadowGenerator | null;
  readonly environment: HDRCubeTexture;
  readonly skybox: Mesh | null;
  /** Centra el shadow map en el jugador para que la sombra no se corte a lo lejos. */
  follow(x: number, z: number): void;
  dispose(): void;
}

/** El cubo es infinito para la cámara; este tamaño también evita límites numéricos cercanos. */
export const SKYBOX_SIZE_M = 10_000;

/** Presenta el mismo HDRI que ilumina los materiales, sin reemplazar el env global. */
export function createEnvironmentSkybox(scene: Scene, environment: HDRCubeTexture): Mesh | null {
  const skybox = CreateBox('cielo-hdri', { size: SKYBOX_SIZE_M }, scene);
  const material = new StandardMaterial('material-cielo-hdri', scene);
  material.backFaceCulling = false;
  material.reflectionTexture = environment.clone();
  if (!material.reflectionTexture) {
    skybox.dispose();
    material.dispose();
    return null;
  }
  material.reflectionTexture.coordinatesMode = Texture.SKYBOX_MODE;
  material.disableLighting = true;
  skybox.material = material;
  skybox.isPickable = false;
  skybox.infiniteDistance = true;
  skybox.ignoreCameraMaxZ = true;
  return skybox;
}

/* ------------------------------------------------------------------------- *
 * Constantes de niebla
 * ------------------------------------------------------------------------- */

/** Densidad por defecto. Justificación y visibilidad en el encabezado. */
export const FOG_DENSITY = 2.5e-4;

/** Densidad de la prueba A/B: el doble. */
export const FOG_DENSITY_DENSE = 5e-4;

/** Visibilidad (fracción de color que sobrevive) que se considera "horizonte". */
export const FOG_HORIZON_VISIBILITY = 0.01;

/** Color de niebla = `scene.clearColor` de `main.ts`, para fundir con el cielo. */
export const FOG_COLOR = Object.freeze({ r: 0.53, g: 0.68, b: 0.82 });

/* ------------------------------------------------------------------------- *
 * Constantes de sombras
 * ------------------------------------------------------------------------- */

/** Lado del mapa de sombras. Chico a propósito: sombras baratas, no bonitas. */
export const SHADOW_MAP_SIZE = 1024;

/** Radio cubierto por el shadow map alrededor del jugador, en metros. */
export const SHADOW_RADIUS_M = 100;

/** Distancia del sol al ancla del jugador, a lo largo del eje de la luz. */
export const SUN_DISTANCE_M = 250;

/**
 * Punto medio del rango de Y de mundo (DEM 870..1194 m absolutos, datum 870 →
 * [0, 324]). `follow` no recibe Y, así que el sol se ancla acá: es el ancla que
 * MINIMIZA el peor corrimiento vertical a lo largo y ancho del mundo.
 */
export const SUN_ANCHOR_Y = 162;

/** Plano cercano del frustum ortogonal de sombras (a lo largo de la luz). */
export const SHADOW_NEAR_Z = 40;

/** Plano lejano del frustum ortogonal de sombras. Cubre receptores y proyectores. */
export const SHADOW_FAR_Z = 450;

/** Sesgo de profundidad constante (~2,5 cm sobre los 490 m de rango). */
export const SHADOW_BIAS = 5e-5;

/** Sesgo a lo largo de la normal (3 cm); evita acne en pendientes sin despegar sombras. */
export const SHADOW_NORMAL_BIAS = 0.03;

/**
 * Dirección de AVANCE de la luz (de la luz hacia la escena), normalizada.
 * Es la misma que `new DirectionalLight('sol', new Vector3(-0.45, -1, -0.35))` de
 * `main.ts`; los shaders normalizan, así que normalizarla acá no cambia el color.
 */
const SUN_TRAVEL_RAW = Object.freeze({ x: -0.45, y: -1, z: -0.35 });

function normalize(v: { readonly x: number; readonly y: number; readonly z: number }): {
  readonly x: number;
  readonly y: number;
  readonly z: number;
} {
  const length = Math.hypot(v.x, v.y, v.z);
  return Object.freeze({ x: v.x / length, y: v.y / length, z: v.z / length });
}

export const SUN_TO_SCENE = normalize(SUN_TRAVEL_RAW);

/* ------------------------------------------------------------------------- *
 * Matemática pura (visible para `scripts/environment/verify_atmosphere.mjs`)
 * ------------------------------------------------------------------------- */

/**
 * Posición del sol para un jugador en (x, z). El punto (x, SUN_ANCHOR_Y, z) queda
 * SOBRE el eje de la vista, por eso el shadow map se centra en el jugador.
 */
export function sunPositionFor(x: number, z: number): { readonly x: number; readonly y: number; readonly z: number } {
  return {
    x: x - SUN_TO_SCENE.x * SUN_DISTANCE_M,
    y: SUN_ANCHOR_Y - SUN_TO_SCENE.y * SUN_DISTANCE_M,
    z: z - SUN_TO_SCENE.z * SUN_DISTANCE_M,
  };
}

/**
 * Distancia perpendicular de un punto de mundo a `SUN_ANCHOR_Y` (mismo X/Z que el
 * jugador) al eje de la vista. Es el corrimiento que tiene que caber en el radio.
 * Para un punto en (x, y, z) con el sol colocado para (x, z):
 *   offset = |y − SUN_ANCHOR_Y| · √(1 − SUN_TO_SCENE.y²)
 */
export function shadowVerticalOffset(y: number): number {
  const horizontal = Math.hypot(SUN_TO_SCENE.x, SUN_TO_SCENE.z);
  return Math.abs(y - SUN_ANCHOR_Y) * horizontal;
}

/**
 * Fracción de color de escena que sobrevive a la niebla EXP2 de Babylon a `distance`:
 * `exp(−(densidad·d)²)`. 1 = sin niebla, 0 = tapado por completo.
 */
export function fogVisibilityAt(distance: number, density: number = FOG_DENSITY): number {
  const scaled = density * distance;
  return Math.exp(-(scaled * scaled));
}

/** Distancia a la que la niebla deja `visibility` de la escena (inversa de la anterior). */
export function fogDistanceForVisibility(visibility: number, density: number = FOG_DENSITY): number {
  return Math.sqrt(-Math.log(visibility)) / density;
}

/* ------------------------------------------------------------------------- *
 * Construcción
 * ------------------------------------------------------------------------- */

export function createAtmosphere(scene: Scene, options: AtmosphereOptions = {}): Atmosphere {
  // --- Niebla ---------------------------------------------------------------
  scene.fogMode = Scene.FOGMODE_EXP2;
  scene.fogColor = new Color3(FOG_COLOR.r, FOG_COLOR.g, FOG_COLOR.b);
  scene.fogDensity = options.dense ? FOG_DENSITY_DENSE : FOG_DENSITY;

  // --- Luces (mismos valores que las de main.ts) ----------------------------
  const ambient = new HemisphericLight('luz-ambiente', new Vector3(0.25, 1, 0.2), scene);
  ambient.intensity = 0.65;
  ambient.groundColor = new Color3(0.28, 0.3, 0.26);

  const sun = new DirectionalLight('sol', new Vector3(SUN_TRAVEL_RAW.x, SUN_TRAVEL_RAW.y, SUN_TRAVEL_RAW.z), scene);
  sun.intensity = 0.95;
  sun.diffuse = new Color3(1, 0.97, 0.9);

  // IBL para los materiales PBR del personaje, pueblo y futuros vehículos GLB.
  // El panorama CC0 está reducido a 1K; el cubemap de 128 px limita memoria y
  // tiempo de prefiltrado. La luz directa y la niebla existentes siguen mandando
  // en la escena. HDRCubeTexture expone los niveles de roughness para PBR.
  const environment = new HDRCubeTexture(
    options.environmentUrl ?? '/environment/hdri/farmland_overcast_1k.hdr',
    scene,
    128,
    false,
    true,
    false,
    true,
    () => console.info('[atmósfera] HDRI rural listo (Poly Haven, 1K → cubemap 128).'),
    (message, exception) => console.error('[atmósfera] No se pudo cargar el HDRI rural.', message, exception),
    false,
    true,
  );
  scene.environmentTexture = environment;
  scene.environmentIntensity = 0.7;
  const skybox = createEnvironmentSkybox(scene, environment);

  // Frustum FIJO: el auto-ajuste a todos los casters distribuiría 1024 téxeles
  // sobre kilómetros si hay miles de árboles. Ver el encabezado.
  sun.shadowFrustumSize = 2 * SHADOW_RADIUS_M;
  sun.shadowMinZ = SHADOW_NEAR_Z;
  sun.shadowMaxZ = SHADOW_FAR_Z;

  // --- Generador de sombras -------------------------------------------------
  const casters = options.shadowCasters ?? [];
  let shadowGenerator: ShadowGenerator | null = null;
  if (casters.length > 0) {
    const generator = new ShadowGenerator(SHADOW_MAP_SIZE, sun);
    // PCF (barato) en vez de ESM: el terreno es plano y no necesita el suavizado
    // exponencial, que además sangra luz en bordes finos.
    generator.usePercentageCloserFiltering = true;
    generator.filteringQuality = ShadowGenerator.QUALITY_LOW;
    generator.bias = SHADOW_BIAS;
    generator.normalBias = SHADOW_NORMAL_BIAS;
    // El terreno NO entra acá: sólo proyectan los casters explícitos.
    for (const mesh of casters) generator.addShadowCaster(mesh, true);
    shadowGenerator = generator;
  }

  // Los receptores reciben sin proyectar (los tiles ya traen receiveShadows = true;
  // esto es por si el orquestador pasa otros meshes).
  for (const mesh of options.shadowReceivers ?? []) mesh.receiveShadows = true;

  // Posición inicial en el origen; el orquestador la corrige con `follow` cada frame.
  const initial = sunPositionFor(0, 0);
  sun.position.set(initial.x, initial.y, initial.z);

  const follow = (x: number, z: number): void => {
    const position = sunPositionFor(x, z);
    sun.position.set(position.x, position.y, position.z);
  };

  return {
    sun,
    ambient,
    environment,
    skybox,
    shadowGenerator,
    follow,
    dispose: () => {
      shadowGenerator?.dispose();
      skybox?.dispose(false, true);
      sun.dispose();
      ambient.dispose();
      if (scene.environmentTexture === environment) scene.environmentTexture = null;
      environment.dispose();
      scene.environmentIntensity = 1;
      scene.fogMode = Scene.FOGMODE_NONE;
      scene.fogDensity = 0;
    },
  };
}
