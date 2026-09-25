/**
 * FASE D — Vegetación procedural sembrada desde landcover real de OSM.
 *
 * El terreno (IGN MDT05) y la red (OSM) ya se ven bien, pero el mapa parecia una
 * maqueta topografica: nada tapaba el color de altura. Esta capa es la que lo hace
 * bosque. Tres decisiones que cierra este archivo:
 *
 *  1. UNA SOLA VERDAD DE ALTURA. El JSON trae solo planta (`x`, `z`); el `y` lo
 *     pide este modulo a `terrain.heightAt`. Preguntarle a cualquier otra fuente
 *     (o reimplementar la interpolacion) deja arboles flotando el dia que cambie
 *     el DEM.
 *  2. THIN INSTANCES, hasta 21 MALLAS para 30.000+ instancias. Un mesh por árbol serian
 *     30.000 draw calls y matarian el frame. Hay 7 tipos x 3 niveles de detalle.
 *  3. EL LOD SE RECALCULA POR DISTANCIA A LA CAMARA, no por el `tier` del JSON.
 *     El `tier` es la banda de distancia a la PRIMERA RUTA (prioridad del build y
 *     estadistica): con la camara sobre la ruta coincide, pero en cuanto la camara
 *     se mueve deja de ser verdad. Acá manda la distancia real al ojo.
 *
 * Nota de iluminacion: los normales salen ANALITICOS hacia afuera, no de
 * `VertexData.ComputeNormals`. Medido contra las primitivas de Babylon 8.56.2:
 * su winding da `dot(cross, normal) = -2.83`, o sea que el normal del winding
 * queda hacia ADENTRO y la vegetacion se iluminaria al reves. Por eso el material
 * usa `backFaceCulling = false` (mismo criterio que terreno, vias y pueblo): la
 * cara visible siempre se ilumina con el normal guardado, con o sin winding.
 */

import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import { Matrix, Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData';
// Import de EFECTO: `thinInstanceSetBuffer` y Cia. cuelgan del prototipo de Mesh
// y solo se cargan desde aca (no desde `Meshes/mesh`). Sin esta linea el bundle
// compila perfecto y revienta en runtime con "no es una funcion".
import '@babylonjs/core/Meshes/thinInstanceMesh';
import type { Scene } from '@babylonjs/core/scene';
import { gridExtent } from '../heightfield';
import type { WorldTerrain } from '../terrain';

/* ------------------------------------------------------------------------- *
 * Contrato (lo consume main.ts cuando el orquestador integre las capas)
 * ------------------------------------------------------------------------- */

/** Corredor a despejar: una polilínea y su semiancho. */
export interface VegetationCorridor {
  readonly points: readonly { readonly x: number; readonly z: number }[];
  readonly halfWidthM: number;
}
/** Zona a despejar por completo (aparición, objetivo). */
export interface VegetationClearing {
  readonly x: number;
  readonly z: number;
  readonly radiusM: number;
}

export interface VegetationStats {
  readonly trees: number;
  readonly shrubs: number;
  readonly grassTufts: number;
  readonly meshes: number;
  readonly instances: number;
  readonly near: number;
  readonly mid: number;
  readonly far: number;
  readonly excludedByCorridor: number;
}

export interface Vegetation {
  readonly stats: VegetationStats;
  /** Ajusta el LOD por distancia a la cámara. Se llama cada frame. */
  update(cameraPosition: { readonly x: number; readonly y: number; readonly z: number }): void;
  dispose(): void;
}

export interface LoadVegetationOptions {
  readonly corridors: readonly VegetationCorridor[];
  readonly clearings: readonly VegetationClearing[];
  /** URL base de los datos. Por defecto `/vegetation/vegetation.json`. */
  readonly url?: string;
}

/* ------------------------------------------------------------------------- *
 * Catalogo y constantes
 * ------------------------------------------------------------------------- */

const DEFAULT_URL = '/vegetation/vegetation.json';

const TREE_TYPES = ['roble', 'pino', 'abedul', 'haya'] as const;
const SHRUB_TYPES = ['jaral', 'enebro'] as const;
const GRASS_TYPES = ['hierba'] as const;
const ALL_TYPES = [...TREE_TYPES, ...SHRUB_TYPES, ...GRASS_TYPES] as const;

type TreeType = (typeof TREE_TYPES)[number];
type ShrubType = (typeof SHRUB_TYPES)[number];
type GrassType = (typeof GRASS_TYPES)[number];
type VegType = TreeType | ShrubType | GrassType;

type Family = 'arbol' | 'arbusto' | 'hierba';

/**
 * Radios de LOD por familia (metros, distancia 3D al ojo). Mas alla del ultimo
 * radio la instancia no se dibuja: es el culling propio, porque las thin
 * instances NO se recortan por frustum una por una.
 *
 * `arbol` lejano = 900 m = `config.viewRadius`, el mismo corte que usa
 * `terrain.cull()`. Con 650 m (el valor original) se veia un DISCO DURO de
 * terreno pelado rodeando la camara: la malla seguia hasta el horizonte y los
 * arboles paraban 250 m antes. Medido en la captura aerea y en un test a
 * 900 m de altura (cero arboles, o sea era el radio y no el landcover).
 * Coste: ~2x triangulos de vegetacion en vista aerea, 0 draw calls extra
 * (siguen siendo 21 mallas como tope).
 */
const LOD_RADII: Record<Family, readonly [number, number, number]> = {
  arbol: [110, 320, 1200],
  arbusto: [90, 250, 500],
  hierba: [45, 120, 220],
};

/**
 * Cuanto se hunde cada familia bajo la cota del terreno (metros). En una ladera
 * el borde del tronco queda POR ENCIMA del suelo en el lado cuesta abajo y se ve
 * un disco volando: hundir 25 cm tapa eso sin que se note en el perfil.
 */
const SINK_M: Record<Family, number> = { arbol: 0.25, arbusto: 0.15, hierba: 0.05 };

/** Variación de silueta por ejemplar sin duplicar mallas ni bandas de LOD. */
const TREE_PROFILES = [
  [0.78, 1.08, 0.84, -0.045, 0.025],
  [1.2, 0.9, 1.12, 0.035, -0.05],
  [0.92, 1.2, 0.78, 0.055, 0.015],
  [1.14, 0.84, 1.2, -0.02, 0.045],
  [0.82, 0.96, 1.18, -0.04, -0.03],
  [1.2, 1.08, 0.82, 0.025, 0.055],
] as const;

function treeProfileIndex(x: number, z: number): number {
  const hash = Math.imul(Math.round(x * 10), 73856093) ^ Math.imul(Math.round(z * 10), 19349663);
  return (hash >>> 0) % TREE_PROFILES.length;
}

/**
 * La reposicion de bandas solo se rehace cuando la camara se movio mas que esto.
 * Repartir 30.000 matrices cuesta ~1 ms; con un umbral de 4 m el resultado
 * visual es identico (los bordes de banda se desplazan 4 m, imperceptible).
 */
const UPDATE_MIN_MOVE_M = 4;

type RGB = readonly [number, number, number];

interface Palette {
  /** Tronco o tallo (los arboles tienen copa de otro color). */
  readonly wood: RGB;
  /** Copa: abajo (sombra propia) y arriba (donde pega el sol). */
  readonly low: RGB;
  readonly high: RGB;
}

/**
 * Paleta rural plana, sin texturas. El color REAL viaja por vertice
 * (`useVertexColors`): con un solo material por familia es lo unico que permite
 * que el tronco sea marron y la copa verde en la misma malla.
 */
const PALETTE: Record<VegType, Palette> = {
  roble: { wood: [0.36, 0.29, 0.21], low: [0.23, 0.35, 0.17], high: [0.38, 0.52, 0.24] },
  pino: { wood: [0.33, 0.26, 0.19], low: [0.18, 0.31, 0.19], high: [0.28, 0.44, 0.26] },
  abedul: { wood: [0.78, 0.76, 0.69], low: [0.43, 0.53, 0.29], high: [0.64, 0.72, 0.4] },
  haya: { wood: [0.43, 0.37, 0.29], low: [0.19, 0.31, 0.19], high: [0.32, 0.47, 0.27] },
  jaral: { wood: [0.36, 0.32, 0.22], low: [0.32, 0.39, 0.21], high: [0.45, 0.51, 0.29] },
  enebro: { wood: [0.34, 0.3, 0.24], low: [0.24, 0.36, 0.25], high: [0.33, 0.45, 0.3] },
  hierba: { wood: [0.3, 0.36, 0.18], low: [0.33, 0.45, 0.2], high: [0.5, 0.62, 0.29] },
};

const familyOf = (type: VegType): Family =>
  (TREE_TYPES as readonly string[]).includes(type)
    ? 'arbol'
    : (SHRUB_TYPES as readonly string[]).includes(type)
      ? 'arbusto'
      : 'hierba';

const isVegType = (value: unknown): value is VegType =>
  typeof value === 'string' && (ALL_TYPES as readonly string[]).includes(value);

const TIERS = ['near', 'mid', 'far'] as const;
type Tier = (typeof TIERS)[number];
const isTier = (value: unknown): value is Tier =>
  typeof value === 'string' && (TIERS as readonly string[]).includes(value);

/* ------------------------------------------------------------------------- *
 * Geometría procedural (VertexData a mano)
 * ------------------------------------------------------------------------- */

interface Geo {
  readonly positions: number[];
  readonly normals: number[];
  readonly colors: number[];
  readonly indices: number[];
  triangles: number;
}

const newGeo = (): Geo => ({ positions: [], normals: [], colors: [], indices: [], triangles: 0 });

function addVertex(g: Geo, x: number, y: number, z: number, nx: number, ny: number, nz: number, c: RGB): number {
  const index = g.positions.length / 3;
  g.positions.push(x, y, z);
  g.normals.push(nx, ny, nz);
  g.colors.push(c[0], c[1], c[2], 1);
  return index;
}

function addTri(g: Geo, a: number, b: number, c: number): void {
  g.indices.push(a, b, c);
  g.triangles++;
}

/** Interpola el color de la base a la cima (`t` en [0,1]). */
function lerpColor(a: RGB, b: RGB, t: number): RGB {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/**
 * Tronco, cono o cono invertido, con tapas opcionales.
 *
 * El winding sigue a `CreateCylinder` de Babylon (anillo con `cos(-a)`, caras
 * `(lower_j, upper_j, lower_j+1)` y `(upper_j+1, lower_j+1, upper_j)`), pero el
 * normal NO sale del winding: sale de la perpendicular a la generatriz
 * `(r0, y0) -> (r1, y1)`, apuntando afuera. Eso da el cilindro y el cono
 * exactos sin depender de cuantos segmentos se pidan.
 *
 * En el vertice de la punta se guardan `seg` normales distintos (una por cara,
 * igual que hace Babylon): con UN solo vertice la copa se sombrea como una
 * esfera y pierde la faceta que la hace leer como cono.
 */
function pushFrustum(
  g: Geo,
  seg: number,
  r0: number,
  r1: number,
  y0: number,
  y1: number,
  baseColor: RGB,
  topColor: RGB,
  capBottom: boolean,
  capTop: boolean,
): void {
  const dy = y1 - y0;
  const nLen = Math.hypot(dy, r0 - r1) || 1;
  const nR = dy / nLen;
  const nY = (r0 - r1) / nLen;

  const ringA: number[] = []; // radio r0 (o punta si r0 = 0)
  const ringB: number[] = []; // radio r1 (o punta si r1 = 0)
  for (let j = 0; j < seg; j++) {
    const angle = (j / seg) * Math.PI * 2;
    const ux = Math.cos(-angle);
    const uz = Math.sin(-angle);
    // Cada anillo guarda su color: la rampa base->cima es lo que hace que la
    // copa se ilumine mas arriba aunque el sol este a contraluz.
    ringA.push(addVertex(g, ux * r0, y0, uz * r0, nR * ux, nY, nR * uz, baseColor));
    ringB.push(addVertex(g, ux * r1, y1, uz * r1, nR * ux, nY, nR * uz, topColor));
  }

  if (r1 > 1e-4 && r0 > 1e-4) {
    // Tronco o cono truncado: bandas de quad.
    for (let j = 0; j < seg; j++) {
      const k = (j + 1) % seg;
      const a = ringA[j]!;
      const b = ringB[j]!;
      const c = ringA[k]!;
      const d = ringB[k]!;
      addTri(g, a, b, c);
      addTri(g, d, c, b);
    }
  } else if (r1 <= 1e-4) {
    // Cono: la punta es `seg` vertices en el mismo punto con normal por cara.
    for (let j = 0; j < seg; j++) {
      const k = (j + 1) % seg;
      addTri(g, ringA[j]!, ringB[j]!, ringA[k]!);
    }
  } else {
    // Cono invertido (r0 = 0): punta abajo.
    for (let j = 0; j < seg; j++) {
      const k = (j + 1) % seg;
      addTri(g, ringB[k]!, ringA[k]!, ringB[j]!);
    }
  }

  // Tapas con vertices PROPIOS (no comparten normal con el lateral: si la
  // compartieran, el borde se redondearia y la copa pareceria un globo).
  const cap = (radius: number, y: number, ny: number, color: RGB, flip: boolean): void => {
    if (radius <= 1e-4) return;
    const center = addVertex(g, 0, y, 0, 0, ny, 0, color);
    const ring: number[] = [];
    for (let j = 0; j < seg; j++) {
      const angle = (j / seg) * Math.PI * 2;
      ring.push(addVertex(g, Math.cos(-angle) * radius, y, Math.sin(-angle) * radius, 0, ny, 0, color));
    }
    for (let j = 0; j < seg; j++) {
      const k = (j + 1) % seg;
      if (flip) addTri(g, center, ring[k]!, ring[j]!);
      else addTri(g, center, ring[j]!, ring[k]!);
    }
  };
  if (capBottom) cap(r0, y0, -1, baseColor, false);
  if (capTop) cap(r1, y1, 1, topColor, true);
}

/**
 * Copa en gota (perfil `sin(pi*t)`): robles, abedules y arbustos.
 *
 * Un blob de 4 anillos son 6*segmentos triangulos y se lee como copa redondeada
 * desde cualquier angulo; un cono de la misma cantidad de triángulos se lee como
 * pino. La normal es la perpendicular al perfil en cada `t`, asi la luz barre la
 * copa de abajo (sombra propia) arriba (luz).
 */
function pushBlob(
  g: Geo,
  seg: number,
  rings: number,
  radius: number,
  y0: number,
  height: number,
  low: RGB,
  high: RGB,
  lobeAmount = 0,
  lobeCount = 4,
): void {
  const ringIndex: number[][] = [];
  const ringT: number[] = [];
  for (let j = 0; j <= rings; j++) {
    const t = j / rings;
    const y = y0 + height * t;
    const color = lerpColor(low, high, t);
    const nY = -radius * Math.PI * Math.cos(Math.PI * t);
    const nLen = Math.hypot(height, nY) || 1;
    const nr = height / nLen;
    const nny = nY / nLen;
    // En las puntas `r = 0` y todos los vertices caen en el eje con normal
    // distinta por cara: mismo truco que `pushFrustum` y que Babylon.
    const col: number[] = [];
    for (let j2 = 0; j2 < seg; j2++) {
      const angle = (j2 / seg) * Math.PI * 2;
      // Broadleaf crowns break the perfect umbrella outline. This is a radial
      // vertex displacement only, so it costs no triangles or draw calls.
      const lobe = 1 + lobeAmount * Math.cos(angle * lobeCount) * Math.sin(Math.PI * t);
      const r = radius * Math.sin(Math.PI * t) * lobe;
      const ux = Math.cos(-angle);
      const uz = Math.sin(-angle);
      col.push(addVertex(g, ux * r, y, uz * r, nr * ux, nny, nr * uz, color));
    }
    ringIndex.push(col);
    ringT.push(t);
  }

  for (let j = 0; j < rings; j++) {
    const lower = ringIndex[j]!;
    const upper = ringIndex[j + 1]!;
    const lowerIsApex = ringT[j]! <= 1e-9 || ringT[j]! >= 1 - 1e-9;
    const upperIsApex = ringT[j + 1]! <= 1e-9 || ringT[j + 1]! >= 1 - 1e-9;
    if (lowerIsApex && upperIsApex) continue;
    if (upperIsApex) {
      for (let k = 0; k < seg; k++) {
        const k2 = (k + 1) % seg;
        addTri(g, lower[k]!, upper[k]!, lower[k2]!);
      }
    } else if (lowerIsApex) {
      for (let k = 0; k < seg; k++) {
        const k2 = (k + 1) % seg;
        addTri(g, upper[k2]!, lower[k]!, upper[k]!);
      }
    } else {
      for (let k = 0; k < seg; k++) {
        const k2 = (k + 1) % seg;
        addTri(g, lower[k]!, upper[k]!, lower[k2]!);
        addTri(g, upper[k2]!, lower[k2]!, upper[k]!);
      }
    }
  }
}

/**
 * Mata de hierba: `blades` planos cruzados. El normal es (0,1,0) — hacia
 * arriba — y no la normal de la cara: asi las dos caras de la hoja se iluminan
 * como el suelo que las rodea y ninguna mata queda negra por estar del lado
 * sombrio respecto del sol.
 */
function pushGrass(g: Geo, blades: number, widthBottom: number, widthTop: number, height: number, low: RGB, high: RGB): void {
  for (let b = 0; b < blades; b++) {
    const angle = (b / blades) * Math.PI;
    const ux = Math.cos(angle);
    const uz = Math.sin(angle);
    const hx = (ux * widthBottom) / 2;
    const hz = (uz * widthBottom) / 2;
    const tx = (ux * widthTop) / 2;
    const tz = (uz * widthTop) / 2;
    const b0 = addVertex(g, -hx, 0, -hz, 0, 1, 0, low);
    const b1 = addVertex(g, hx, 0, hz, 0, 1, 0, low);
    const t0 = addVertex(g, -tx, height, -tz, 0, 1, 0, high);
    const t1 = addVertex(g, tx, height, tz, 0, 1, 0, high);
    addTri(g, b0, t0, b1);
    addTri(g, t1, b1, t0);
  }
}

/**
 * Geometría de UNA (tipo, banda). El nivel `far` es el barato que pide la
 * tarea: sin tronco y con menos segmentos. Las medidas estan en METROS y luego
 * las multiplica el `scale` de cada instancia.
 */
function buildGeometry(type: VegType, band: 0 | 1 | 2): Geo {
  const g = newGeo();
  const p = PALETTE[type];
  const near = band === 0;
  const mid = band === 1;

  if (type === 'roble') {
    if (band === 2) {
      // Sin tronco (lo pide la tarea para `far`): la copa llega hasta el suelo
      // para que no se vea un hueco debajo a 500 m.
      pushBlob(g, 5, 2, 3.0, 0, 6.2, p.low, p.high, 0.14, 2);
    } else {
      pushFrustum(g, near ? 7 : 5, 0.34, 0.24, 0, near ? 3 : 2.6, p.wood, p.wood, true, false);
      pushBlob(
        g,
        near ? 10 : 6,
        near ? 4 : 3,
        near ? 3.0 : 2.6,
        near ? 2.25 : 2.1,
        near ? 4.45 : 4.0,
        p.low,
        p.high,
        near ? 0.18 : 0.14,
        near ? 5 : 3,
      );
    }
    return g;
  }
  if (type === 'pino') {
    if (band === 2) {
      pushFrustum(g, 6, 2.2, 0, 0, 7.4, p.low, p.high, true, false);
    } else {
      pushFrustum(g, near ? 7 : 5, 0.28, 0.18, 0, near ? 2.4 : 2.2, p.wood, p.wood, true, false);
      if (near) {
        // Tres faldones: es lo que hace que un pino se lea de perfil.
        pushFrustum(g, 8, 2.1, 0, 1.6, 4.2, p.low, p.high, true, false);
        pushFrustum(g, 8, 1.55, 0, 3.4, 5.9, p.low, p.high, true, false);
        pushFrustum(g, 8, 1.0, 0, 5.1, 7.4, p.low, p.high, true, false);
      } else {
        pushFrustum(g, 6, 2.0, 0, 1.6, 4.6, p.low, p.high, true, false);
        pushFrustum(g, 6, 1.3, 0, 4.0, 7.0, p.low, p.high, true, false);
      }
    }
    return g;
  }
  if (type === 'abedul') {
    if (band === 2) {
      pushBlob(g, 5, 2, 1.5, 0, 7.4, p.low, p.high, 0.08, 2);
    } else {
      pushFrustum(g, near ? 6 : 4, 0.2, 0.13, 0, near ? 4.6 : 4.0, p.wood, p.wood, true, false);
      pushBlob(g, near ? 9 : 6, 3, near ? 1.7 : 1.6, near ? 3.8 : 3.45, near ? 4.55 : 4.25, p.low, p.high, near ? 0.1 : 0.08, 3);
    }
    return g;
  }
  if (type === 'haya') {
    if (band === 2) {
      // En el horizonte, copa ovalada y alta para distinguir el hayedo de los pinos.
      pushBlob(g, 5, 2, 2.35, 0, 8.2, p.low, p.high, 0.1, 3);
    } else {
      pushFrustum(g, near ? 7 : 5, 0.29, 0.2, 0, near ? 5.2 : 4.5, p.wood, p.wood, true, false);
      pushBlob(
        g,
        near ? 10 : 6,
        near ? 4 : 3,
        near ? 2.65 : 2.35,
        near ? 4.35 : 3.9,
        near ? 4.25 : 3.9,
        p.low,
        p.high,
        near ? 0.12 : 0.1,
        5,
      );
    }
    return g;
  }
  if (type === 'jaral') {
    pushBlob(g, near ? 8 : mid ? 6 : 5, near || mid ? 3 : 2, 1.25, 0.1, near ? 1.7 : 1.6, p.low, p.high);
    return g;
  }
  if (type === 'enebro') {
    pushFrustum(g, near ? 8 : mid ? 6 : 5, 1.05, 0, 0.1, near || mid ? 2 : 1.9, p.low, p.high, true, false);
    return g;
  }
  // hierba
  pushGrass(g, near ? 3 : 2, 0.5, 0.16, 0.6, p.low, p.high);
  return g;
}

/* ------------------------------------------------------------------------- *
 * Datos: parseo defensivo de vegetation.json
 * ------------------------------------------------------------------------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface RawInstance {
  readonly x: number;
  readonly z: number;
  readonly type: VegType;
  readonly scale: number;
  readonly rotation: number;
  readonly tier: Tier;
}

function parseInstances(raw: unknown): RawInstance[] {
  if (!isRecord(raw)) throw new Error('vegetacion: la raiz debe ser un objeto');
  const meta = raw.meta;
  const versionOk = raw.schemaVersion === 1 || (isRecord(meta) && meta.schemaVersion === 1);
  if (!versionOk) throw new Error('vegetacion: schemaVersion no soportada');
  const list = raw.instances;
  if (!Array.isArray(list)) throw new Error('vegetacion: falta el array "instances"');

  const out: RawInstance[] = [];
  for (const item of list) {
    if (!isRecord(item)) continue;
    const { x, z, scale, rotation } = item;
    if (typeof x !== 'number' || typeof z !== 'number' || !Number.isFinite(x) || !Number.isFinite(z)) continue;
    if (typeof scale !== 'number' || !Number.isFinite(scale) || scale <= 0) continue;
    if (typeof rotation !== 'number' || !Number.isFinite(rotation)) continue;
    if (!isVegType(item.type) || !isTier(item.tier)) continue;
    out.push({ x, z, type: item.type, scale, rotation, tier: item.tier });
  }
  return out;
}

/* ------------------------------------------------------------------------- *
 * Red de seguridad: despeje en runtime
 * ------------------------------------------------------------------------- */

/**
 * El build ya despeja corredores y claros, y `--check` lo verifica. Esto es la
 * red por si el JSON quedo viejo respecto de la ruta: sin ella, un arbol sobre
 * la calzada se veria y nadie sabria de donde salio.
 *
 * La grilla uniforme es la misma idea que en el build: cada segmento se registra
 * en las celdas que cubre su bbox inflado, y el punto solo mira su propia celda.
 * Chequear los ~4.450 segmentos contra 30.000 puntos serian 136 M de operaciones
 * en el hilo de carga (~1 s de congelon al arrancar).
 */
const CORR_CELL_M = 100;
const CORR_KEY_OFFSET = 1000;
const corrKey = (i: number, j: number): number => (i + CORR_KEY_OFFSET) * 4096 + (j + CORR_KEY_OFFSET);

interface CorrSeg {
  readonly ax: number;
  readonly az: number;
  readonly bx: number;
  readonly bz: number;
  readonly halfWidthM: number;
}

function pointSegDist(px: number, pz: number, s: CorrSeg): number {
  const dx = s.bx - s.ax;
  const dz = s.bz - s.az;
  const len2 = dx * dx + dz * dz;
  let t = len2 > 0 ? ((px - s.ax) * dx + (pz - s.az) * dz) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const ex = s.ax + t * dx - px;
  const ez = s.az + t * dz - pz;
  return Math.sqrt(ex * ex + ez * ez);
}

function buildCorridorIndex(corridors: readonly VegetationCorridor[]): Map<number, CorrSeg[]> {
  const grid = new Map<number, CorrSeg[]>();
  for (const corridor of corridors) {
    const half = corridor.halfWidthM;
    for (let i = 0; i + 1 < corridor.points.length; i++) {
      const a = corridor.points[i]!;
      const b = corridor.points[i + 1]!;
      const seg: CorrSeg = { ax: a.x, az: a.z, bx: b.x, bz: b.z, halfWidthM: half };
      const i0 = Math.floor((Math.min(a.x, b.x) - half) / CORR_CELL_M);
      const i1 = Math.floor((Math.max(a.x, b.x) + half) / CORR_CELL_M);
      const j0 = Math.floor((Math.min(a.z, b.z) - half) / CORR_CELL_M);
      const j1 = Math.floor((Math.max(a.z, b.z) + half) / CORR_CELL_M);
      for (let cj = j0; cj <= j1; cj++) {
        for (let ci = i0; ci <= i1; ci++) {
          const key = corrKey(ci, cj);
          const list = grid.get(key);
          if (list) list.push(seg);
          else grid.set(key, [seg]);
        }
      }
    }
  }
  return grid;
}

/* ------------------------------------------------------------------------- *
 * Grupos de instancias y buckets por banda
 * ------------------------------------------------------------------------- */

interface Group {
  readonly type: VegType;
  readonly family: Family;
  /** Matrices ya compuestas; `count` es el indice de llenado durante la carga. */
  matrices: Float32Array;
  count: number;
}

interface Bucket {
  readonly mesh: Mesh;
  /** Capacidad = instancias del tipo: ninguna banda puede desbordarla. */
  readonly buffer: Float32Array;
}

const BANDS = [0, 1, 2] as const;
type Band = (typeof BANDS)[number];

function applyBand(bucket: Bucket, count: number): void {
  // Orden IMPORTANTE: el upload manda `thinInstanceCount` elementos, asi que
  // primero se fija el conteo y despues se vuelca el buffer.
  bucket.mesh.thinInstanceCount = count;
  bucket.mesh.isVisible = count > 0;
  if (count > 0) bucket.mesh.thinInstanceBufferUpdated('matrix');
}

function createMaterial(scene: Scene, name: string, ambient: number): StandardMaterial {
  const material = new StandardMaterial(name, scene);
  // Blanco a proposito: el color real lo pone el vertice (`useVertexColors`).
  // Si el diffuse fuera verde, se multiplicaria por el verde de la copa y todo
  // quedaria oscuro.
  material.diffuseColor = new Color3(1, 1, 1);
  material.ambientColor = new Color3(ambient, ambient, ambient);
  material.specularColor = new Color3(0.03, 0.03, 0.03);
  // Mismo criterio que terreno, vias y pueblo: sin back-face culling. Con el
  // winding de las primitivas de Babylon la cara visible depende del giro de la
  // camara; sin culling, la copa jamas desaparece y el normal analitico manda.
  material.backFaceCulling = false;
  material.freeze();
  return material;
}

function createMesh(scene: Scene, type: VegType, band: Band, material: StandardMaterial, buffer: Float32Array): Mesh {
  const geo = buildGeometry(type, band);
  const vertexData = new VertexData();
  vertexData.positions = new Float32Array(geo.positions);
  vertexData.normals = new Float32Array(geo.normals);
  vertexData.colors = new Float32Array(geo.colors);
  vertexData.indices = new Uint32Array(geo.indices);

  const mesh = new Mesh(`veg:${type}:${band}`, scene);
  vertexData.applyToMesh(mesh, false);
  mesh.material = material;
  mesh.useVertexColors = true;
  mesh.isPickable = false;
  // Recibe sombras del sol y del pueblo, pero no las PROYECTA: la vegetacion
  // esta fuera del ShadowGenerator (costo) segun la milestone.
  mesh.receiveShadows = true;
  // La caja envolvente de la malla base no sirve para 30.000 instancias: sin
  // estas dos banderas Babylon intentaria recalcularla por instancia y, peor,
  // recortaria la vegetacion por frustum (las thin instances no se recortan una
  // por una). El culling lo hace `update()` por distancia.
  mesh.doNotSyncBoundingInfo = true;
  mesh.alwaysSelectAsActiveMesh = true;
  // staticBuffer = false → buffer updatable: `thinInstanceBufferUpdated`
  // vuelca sin recrear el buffer de GPU en cada actualizacion.
  mesh.thinInstanceSetBuffer('matrix', buffer, 16, false);
  mesh.thinInstanceCount = 0;
  mesh.isVisible = false;
  return mesh;
}

/* ------------------------------------------------------------------------- *
 * Carga
 * ------------------------------------------------------------------------- */

/**
 * Carga `vegetation.json`, arma hasta 21 mallas (7 tipos x 3 niveles) y devuelve
 * el control de LOD. No dibuja nada hasta el primer `update()`.
 */
export async function loadVegetation(
  scene: Scene,
  terrain: WorldTerrain,
  options: LoadVegetationOptions,
): Promise<Vegetation> {
  const url = options.url ?? DEFAULT_URL;

  const response = await fetch(url);
  if (!response.ok) throw new Error(`vegetacion: no se pudo cargar ${url} (HTTP ${response.status})`);
  const parsed = parseInstances((await response.json()) as unknown);

  // Dominio real del terreno. `terrain.heightAt` fuera de la ventana devuelve el
  // absoluto sin restar el datum (o 0, segun la referencia): eso clavaria la
  // instancia 870 m bajo tierra. El build ya garantiza que todo esta adentro;
  // esto es la red de seguridad.
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
  const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

  const corrGrid = buildCorridorIndex(options.corridors);
  const inCorridor = (x: number, z: number): boolean => {
    const list = corrGrid.get(corrKey(Math.floor(x / CORR_CELL_M), Math.floor(z / CORR_CELL_M)));
    if (!list) return false;
    for (const seg of list) if (pointSegDist(x, z, seg) <= seg.halfWidthM) return true;
    return false;
  };
  const inClearing = (x: number, z: number): boolean =>
    options.clearings.some((c) => Math.hypot(x - c.x, z - c.z) <= c.radiusM);

  // 1) Filtrado + alturas + despeje: se resuelve ANTES de reservar los buffers,
  //    porque cuantas instancias queden define el tamanio de cada bucket.
  const kept: { readonly raw: RawInstance; readonly y: number }[] = [];
  const excluded = { corridor: 0, outside: 0, badHeight: 0 };
  for (const raw of parsed) {
    if (raw.x < minX || raw.x > maxX || raw.z < minZ || raw.z > maxZ) {
      excluded.outside++;
      continue;
    }
    if (inCorridor(raw.x, raw.z) || inClearing(raw.x, raw.z)) {
      excluded.corridor++;
      continue;
    }
    // SIEMPRE terrain.heightAt, con la coordenada recortada al dominio. Nunca
    // una interpolacion propia: la malla usa la diagonal SO->NE y una bilineal
    // se desvia hasta 0,29 m.
    const y = terrain.heightAt(clamp(raw.x, minX, maxX), clamp(raw.z, minZ, maxZ));
    if (!Number.isFinite(y)) {
      excluded.badHeight++;
      continue;
    }
    kept.push({ raw, y });
  }

  if (excluded.outside > 0 || excluded.badHeight > 0) {
    console.warn(
      `[vegetacion] descartadas en runtime: ${excluded.outside} fuera del terreno, ` +
        `${excluded.badHeight} con altura no finita (el build no deberia emitirlas)`,
    );
  }

  // 2) Buffers canonicos por tipo: matrices ya compuestas (rotacion + escala +
  //    traslacion). `update()` solo las REORDENA entre bandas, no las recalcula.
  const totals = new Map<VegType, number>();
  for (const { raw } of kept) totals.set(raw.type, (totals.get(raw.type) ?? 0) + 1);
  const groups = new Map<VegType, Group>();
  for (const [type, total] of totals) {
    groups.set(type, { type, family: familyOf(type), matrices: new Float32Array(total * 16), count: 0 });
  }

  const scaleVec = new Vector3();
  const rotQuat = new Quaternion();
  const posVec = new Vector3();
  const composed = new Matrix();
  const tierCounts: Record<Tier, number> = { near: 0, mid: 0, far: 0 };
  const familyCounts: Record<Family, number> = { arbol: 0, arbusto: 0, hierba: 0 };

  for (const { raw, y } of kept) {
    const group = groups.get(raw.type)!;
    const sink = SINK_M[group.family];
    if (group.family === 'arbol') {
      const profile = TREE_PROFILES[treeProfileIndex(raw.x, raw.z)]!;
      scaleVec.set(raw.scale * profile[0], raw.scale * profile[1], raw.scale * profile[2]);
      Quaternion.FromEulerAnglesToRef(profile[3], raw.rotation, profile[4], rotQuat);
    } else {
      scaleVec.setAll(raw.scale);
      Quaternion.FromEulerAnglesToRef(0, raw.rotation, 0, rotQuat);
    }
    // El `y` de la instancia es el suelo MENOS el hundimiento. La escala no
    // uniforme solo cambia la silueta; la base sigue apoyada en ese punto.
    posVec.set(raw.x, y - sink, raw.z);
    Matrix.ComposeToRef(scaleVec, rotQuat, posVec, composed);
    const o = group.count * 16;
    for (let k = 0; k < 16; k++) group.matrices[o + k] = composed.m[k]!;
    group.count++;
    tierCounts[raw.tier]++;
    familyCounts[group.family]++;
  }

  // 3) Materiales + hasta 21 mallas. Solo se crea una malla para un tipo que exista.
  const solidMaterial = createMaterial(scene, 'vegetacion:solido', 0.3);
  const grassMaterial = createMaterial(scene, 'vegetacion:hierba', 0.36);
  const buckets = new Map<VegType, Bucket[]>();
  const meshes: Mesh[] = [];

  for (const group of groups.values()) {
    const material = group.family === 'hierba' ? grassMaterial : solidMaterial;
    const list: Bucket[] = [];
    for (const band of BANDS) {
      const buffer = new Float32Array(group.matrices.length);
      const mesh = createMesh(scene, group.type, band, material, buffer);
      meshes.push(mesh);
      list.push({ mesh, buffer });
    }
    buckets.set(group.type, list);
  }

  const stats: VegetationStats = {
    trees: familyCounts.arbol,
    shrubs: familyCounts.arbusto,
    grassTufts: familyCounts.hierba,
    meshes: meshes.length,
    instances: kept.length,
    near: tierCounts.near,
    mid: tierCounts.mid,
    far: tierCounts.far,
    excludedByCorridor: excluded.corridor,
  };

  console.info(
    `[vegetacion] ${stats.instances} instancias · ${stats.trees} árboles · ${stats.shrubs} arbustos · ` +
      `${stats.grassTufts} matas · ${stats.meshes} mallas · tier ${stats.near}/${stats.mid}/${stats.far} · ` +
      `${stats.excludedByCorridor} excluidas en runtime`,
  );

  let disposed = false;
  let last: { x: number; y: number; z: number } | null = null;

  const update = (cameraPosition: { readonly x: number; readonly y: number; readonly z: number }): void => {
    if (disposed) return;
    if (last) {
      const dx = cameraPosition.x - last.x;
      const dy = cameraPosition.y - last.y;
      const dz = cameraPosition.z - last.z;
      if (dx * dx + dy * dy + dz * dz < UPDATE_MIN_MOVE_M * UPDATE_MIN_MOVE_M) return;
    }
    last = { x: cameraPosition.x, y: cameraPosition.y, z: cameraPosition.z };
    const cx = last.x;
    const cy = last.y;
    const cz = last.z;

    for (const group of groups.values()) {
      const list = buckets.get(group.type);
      if (!list) continue;
      const radii = LOD_RADII[group.family];
      const rNear = radii[0]! * radii[0]!;
      const rMid = radii[1]! * radii[1]!;
      const rFar = radii[2]! * radii[2]!;
      const src = group.matrices;
      // Buckets resueltos una sola vez: con `noUncheckedIndexedAccess` cada
      // `list[i]` es opcional y el compilador no acepta indizar con una
      // variable. Tres referencias locales, cero ramas en el hot path.
      const nearBucket = list[0]!;
      const midBucket = list[1]!;
      const farBucket = list[2]!;
      const nearBuf = nearBucket.buffer;
      const midBuf = midBucket.buffer;
      const farBuf = farBucket.buffer;
      let writtenNear = 0;
      let writtenMid = 0;
      let writtenFar = 0;

      for (let k = 0; k < group.count; k++) {
        const o = k * 16;
        const dx = src[o + 12]! - cx;
        const dy = src[o + 13]! - cy;
        const dz = src[o + 14]! - cz;
        const d2 = dx * dx + dy * dy + dz * dz;
        let buf: Float32Array;
        let w: number;
        if (d2 < rNear) {
          buf = nearBuf;
          w = writtenNear * 16;
          writtenNear++;
        } else if (d2 < rMid) {
          buf = midBuf;
          w = writtenMid * 16;
          writtenMid++;
        } else if (d2 < rFar) {
          buf = farBuf;
          w = writtenFar * 16;
          writtenFar++;
        } else {
          continue; // fuera del ultimo radio: no se dibuja (culling propio)
        }
        // Copia plana de los 16 floats, sin `subarray`: 30.000 vistas
        // temporales por frame son una presion de GC constante en un juego
        // que ya va justito de frame. El `!` es porque con
        // `noUncheckedIndexedAccess` cada lectura de un Float32Array es
        // opcional; aqui el indice siempre esta en rango.
        for (let j = 0; j < 16; j++) buf[w + j] = src[o + j]!;
      }

      applyBand(nearBucket, writtenNear);
      applyBand(midBucket, writtenMid);
      applyBand(farBucket, writtenFar);
    }
  };

  return {
    stats,
    update,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      for (const mesh of meshes) mesh.dispose();
      solidMaterial.dispose();
      grassMaterial.dispose();
      buckets.clear();
      groups.clear();
      last = null;
    },
  };
}
