import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
export function gridExtent(grid) {
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
export function containsPoint(grid, x, z) {
    const { minX, maxX, minZ, maxZ } = gridExtent(grid);
    return x >= minX && x <= maxX && z >= minZ && z <= maxZ;
}
function isFiniteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value);
}
/** Valida la forma del grid, incluido el invariante de longitud de `heights`. */
export function assertValidGrid(grid) {
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
        throw new Error(`heightfield: heights.length (${grid.heights.length}) !== columns*rows (${grid.columns * grid.rows})`);
    }
}
/**
 * Altura cruda (metros) de la superficie triangulada.
 * Reproduce el split SW→NE de cada celda: la diagonal va de la esquina
 * suroeste (i,j) a la noreste (i+1,j+1), así el JS y el `.py` que exporta el
 * terreno coinciden exactamente. Fuera del grid devuelve 0.
 */
function surfaceMeters(grid, x, z) {
    if (!Number.isFinite(x) || !Number.isFinite(z))
        return 0;
    const c = (x - grid.x0) / grid.dx;
    const r = (z - grid.z0) / grid.dz;
    if (c < 0 || r < 0 || c > grid.columns - 1 || r > grid.rows - 1)
        return 0;
    const i = Math.min(Math.floor(c), grid.columns - 2);
    const j = Math.min(Math.floor(r), grid.rows - 2);
    const u = c - i;
    const v = r - j;
    const k = j * grid.columns + i;
    const h = grid.heights;
    const hSW = h[k];
    const hSE = h[k + 1];
    const hNW = h[k + grid.columns];
    const hNE = h[k + grid.columns + 1];
    // Cada celda se parte SW→NE.
    return u >= v
        ? hSW * (1 - u) + hSE * (u - v) + hNE * v
        : hSW * (1 - v) + hNE * u + hNW * (v - u);
}
/**
 * Crea el sampler de altura/normal.
 * @param worldScale unidades de mundo por metro (ver `TerrainConfig.worldScale`).
 */
export function createHeightfield(grid, worldScale = 1) {
    assertValidGrid(grid);
    const { minX, maxX, minZ, maxZ } = gridExtent(grid);
    // Paso de diferencias finitas: el del grid. Se acota a un cuarto de la celda
    // para no cruzar más de un vecino si algún día el grid es anisotrópico.
    const step = Math.min(grid.dx, grid.dz);
    const heightAt = (x, z) => surfaceMeters(grid, x, z) * worldScale;
    const normalAt = (x, z, out) => {
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
    const sampleHeight = (x, z) => ({
        height: heightAt(x, z),
        normal: normalAt(x, z),
    });
    return { grid, worldScale, heightAt, normalAt, sampleHeight };
}
