import { Vector3 } from '@babylonjs/core/Maths/math.vector';

/**
 * Heightfield en el MISMO esquema que el repo de referencia (GTA_SZ), de modo que
 * los tiles que produzca la FASE 2 entren sin traducción.
 *
 * Semántica del grid:
 * - `x0`/`z0`: esquina (columna 0, fila 0) en unidades de mundo.
 * - `dx`/`dz`: paso entre columnas/filas, en unidades de mundo (> 0).
 * - `columns`/`rows`: cantidad de muestras por eje (>= 2).
 * - `heights`: alturas en METROS, orden fila-mayor: `heights[r * columns + c]`.
 *   Las filas crecen hacia el norte (+Z), las columnas hacia el este (+X).
 *
 * INVARIANTE: `heights.length === columns * rows`.
 */
export interface HeightfieldGrid {
  readonly x0: number;
  readonly z0: number;
  readonly dx: number;
  readonly dz: number;
  readonly columns: number;
  readonly rows: number;
  readonly heights: readonly number[];
}

/** Muestra de terreno lista para física/colocación (Y-up). */
export interface TerrainSample {
  /** Altura en unidades de mundo (altura en metros × worldScale). */
  readonly height: number;
  /** Normal unitaria en espacio de mundo. */
  readonly normal: Vector3;
}

export interface HeightfieldSampler {
  readonly grid: HeightfieldGrid;
  readonly worldScale: number;
  /** Altura interpolada en unidades de mundo. Fuera del grid devuelve 0 (semántica de referencia). */
  heightAt(x: number, z: number): number;
  /** Normal por diferencias finitas del heightfield (no de los vértices de la malla). */
  normalAt(x: number, z: number, out?: Vector3): Vector3;
  /** Atajo: altura + normal en una sola llamada. */
  sampleHeight(x: number, z: number): TerrainSample;
}

/** Extensión horizontal del grid, útil para ubicar cámaras y resolver tiles. */
export interface GridExtent {
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
  readonly centerX: number;
  readonly centerZ: number;
}

export function gridExtent(grid: HeightfieldGrid): GridExtent {
  const maxX = grid.x0 + (grid.columns - 1) * grid.dx;
  const maxZ = grid.z0 + (grid.rows - 1) * grid.dz;
  return {
    minX: grid.x0,
    maxX,
    minZ: grid.z0,
    maxZ,
    centerX: (grid.x0 + maxX) / 2,
    centerZ: (grid.z0 + maxZ) / 2,
  };
}

export function containsPoint(grid: HeightfieldGrid, x: number, z: number): boolean {
  const { minX, maxX, minZ, maxZ } = gridExtent(grid);
  return x >= minX && x <= maxX && z >= minZ && z <= maxZ;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Valida la forma del grid, incluido el invariante de longitud de `heights`. */
export function assertValidGrid(grid: HeightfieldGrid): void {
  if (!isFiniteNumber(grid.x0) || !isFiniteNumber(grid.z0)) {
    throw new Error('heightfield: x0/z0 deben ser finitos');
  }
  if (!isFiniteNumber(grid.dx) || grid.dx <= 0 || !isFiniteNumber(grid.dz) || grid.dz <= 0) {
    throw new Error('heightfield: dx/dz deben ser > 0');
  }
  if (!Number.isInteger(grid.columns) || !Number.isInteger(grid.rows) || grid.columns < 2 || grid.rows < 2) {
    throw new Error('heightfield: columns/rows deben ser enteros >= 2');
  }
  if (grid.heights.length !== grid.columns * grid.rows) {
    throw new Error(
      `heightfield: heights.length (${grid.heights.length}) !== columns*rows (${grid.columns * grid.rows})`,
    );
  }
}

/**
 * Altura cruda (metros) de la superficie triangulada.
 * Reproduce el split SW→NE de cada celda: la diagonal va de la esquina
 * suroeste (i,j) a la noreste (i+1,j+1), así el JS y el `.py` que exporta el
 * terreno coinciden exactamente. Fuera del grid devuelve 0.
 */
function surfaceMeters(grid: HeightfieldGrid, x: number, z: number): number {
  if (!Number.isFinite(x) || !Number.isFinite(z)) return 0;
  const c = (x - grid.x0) / grid.dx;
  const r = (z - grid.z0) / grid.dz;
  if (c < 0 || r < 0 || c > grid.columns - 1 || r > grid.rows - 1) return 0;

  const i = Math.min(Math.floor(c), grid.columns - 2);
  const j = Math.min(Math.floor(r), grid.rows - 2);
  const u = c - i;
  const v = r - j;
  const k = j * grid.columns + i;
  const h = grid.heights;
  const hSW = h[k]!;
  const hSE = h[k + 1]!;
  const hNW = h[k + grid.columns]!;
  const hNE = h[k + grid.columns + 1]!;

  // Cada celda se parte SW→NE.
  return u >= v
    ? hSW * (1 - u) + hSE * (u - v) + hNE * v
    : hSW * (1 - v) + hNE * u + hNW * (v - u);
}

/**
 * Crea el sampler de altura/normal.
 * @param worldScale unidades de mundo por metro (ver `TerrainConfig.worldScale`).
 */
export function createHeightfield(grid: HeightfieldGrid, worldScale = 1): HeightfieldSampler {
  assertValidGrid(grid);
  const { minX, maxX, minZ, maxZ } = gridExtent(grid);
  // Paso de diferencias finitas: el del grid. Se acota a un cuarto de la celda
  // para no cruzar más de un vecino si algún día el grid es anisotrópico.
  const step = Math.min(grid.dx, grid.dz);

  const heightAt = (x: number, z: number): number => surfaceMeters(grid, x, z) * worldScale;

  const normalAt = (x: number, z: number, out?: Vector3): Vector3 => {
    const target = out ?? new Vector3();
    // Se recortan los puntos de muestreo al dominio para no leer el 0 de afuera
    // y generar un acantilado artificial en los bordes.
    const xLeft = Math.max(minX, x - step);
    const xRight = Math.min(maxX, x + step);
    const zBack = Math.max(minZ, z - step);
    const zForward = Math.min(maxZ, z + step);

    const spanX = xRight - xLeft;
    const spanZ = zForward - zBack;
    const dHx = spanX > 0 ? (surfaceMeters(grid, xRight, z) - surfaceMeters(grid, xLeft, z)) * worldScale / spanX : 0;
    const dHz = spanZ > 0 ? (surfaceMeters(grid, x, zForward) - surfaceMeters(grid, x, zBack)) * worldScale / spanZ : 0;

    // Y-up: normal = normalize(-dH/dx, 1, -dH/dz).
    target.set(-dHx, 1, -dHz);
    target.normalize();
    return target;
  };

  const sampleHeight = (x: number, z: number): TerrainSample => ({
    height: heightAt(x, z),
    normal: normalAt(x, z),
  });

  return { grid, worldScale, heightAt, normalAt, sampleHeight };
}
