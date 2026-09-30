import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import type { RoadClass, RoadTerrain } from '../road-draping';
export interface RoadSurfaceSample {
    height: number;
    normal: Vector3;
    longitudinalSlope: number;
    crossSlope: number;
    class: RoadClass;
    bridge: boolean;
    skirt?: boolean;
    tangentX?: number;
    tangentZ?: number;
}
export interface RoadSurfaceSampler extends RoadTerrain {
    sampleAt(x: number, z: number): RoadSurfaceSample | null;
}
const BANK_LIMIT: Record<RoadClass, number> = { ROAD: 0.08, TRACK: 0.25, PATH: 0.45 };
/** Queries the actual final triangles, including clearance lifts, so wheel contacts
 * agree with visible pavement. Skirts, signs and painted overlays are excluded. */
export function createRenderedRoadSurface(terrain: RoadTerrain, bands: readonly {
    class: RoadClass;
    positions: ArrayLike<number>;
    indices: ArrayLike<number>;
    roles: ArrayLike<number>;
    stations?: readonly {x:number;z:number;dx:number;dz:number}[];
}[]): RoadSurfaceSampler {
    const cells = new Map<string, {
        band: typeof bands[number];
        a: number;
        b: number;
        c: number;
    }[]>(), size = 32;
    const directions = new Map<string, {x:number;z:number;dx:number;dz:number}[]>();
    for (const band of bands) for (const station of band.stations ?? []) {
        const key = `${band.class}/${Math.floor(station.x / size)},${Math.floor(station.z / size)}`;
        const list = directions.get(key) ?? []; list.push(station); directions.set(key, list);
    }
    for (const band of bands)
        for (let i = 0; i < band.indices.length; i += 3) {
            const a = band.indices[i]!, b = band.indices[i + 1]!, c = band.indices[i + 2]!;
            if ([a, b, c].some(v => band.roles[v] !== 0 && band.roles[v] !== 1 && band.roles[v] !== 2))
                continue;
            const p = band.positions;
            for (let x = Math.floor(Math.min(p[a * 3]!, p[b * 3]!, p[c * 3]!) / size); x <= Math.floor(Math.max(p[a * 3]!, p[b * 3]!, p[c * 3]!) / size); x++)
                for (let z = Math.floor(Math.min(p[a * 3 + 2]!, p[b * 3 + 2]!, p[c * 3 + 2]!) / size); z <= Math.floor(Math.max(p[a * 3 + 2]!, p[b * 3 + 2]!, p[c * 3 + 2]!) / size); z++) {
                    const k = `${x},${z}`, list = cells.get(k) ?? [];
                    list.push({ band, a, b, c });
                    cells.set(k, list);
                }
        }
    const sampleAt = (x: number, z: number): RoadSurfaceSample | null => {
        let best: RoadSurfaceSample | null = null;
        for (const { band, a, b, c } of cells.get(`${Math.floor(x / size)},${Math.floor(z / size)}`) ?? []) {
            const p = band.positions, ax = p[a * 3]!, az = p[a * 3 + 2]!, bx = p[b * 3]!, bz = p[b * 3 + 2]!, cx = p[c * 3]!, cz = p[c * 3 + 2]!, det = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
            if (Math.abs(det) < 1e-10)
                continue;
            const u = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / det, v = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / det, w = 1 - u - v;
            if (Math.min(u, v, w) < -5e-4)
                continue;
            const ay = p[a * 3 + 1]!, by = p[b * 3 + 1]!, cy = p[c * 3 + 1]!, height = u * ay + v * by + w * cy;
            if (best && height <= best.height)
                continue;
            const nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay), ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az), nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
            const normal = new Vector3(nx, ny, nz).normalize();
            if (normal.y < 0)
                normal.scaleInPlace(-1);
            // A near-vertical triangle is a skirt/overlap seam, not a drivable
            // pavement facet. Ignore it for contact and diagnostics so a road
            // crossing cannot inject a false wall normal into the vehicle.
            const minSupportY = band.class === 'ROAD' ? 0.95 : band.class === 'TRACK' ? 0.9 : 0.85;
            if (normal.y < minSupportY)
                continue;
            const tx = 0, tz = 1;
            best = { height, normal, class: band.class, bridge: band.roles[a] === 2, skirt: [a,b,c].some(v=>band.roles[v]===1), longitudinalSlope: -(normal.x * tx + normal.z * tz) / normal.y, crossSlope: (normal.x * tz - normal.z * tx) / normal.y };
        }
        if (best) {
            let distance = Infinity, tx = 0, tz = 1;
            const cellX = Math.floor(x / size), cellZ = Math.floor(z / size);
            for (let ix = cellX - 1; ix <= cellX + 1; ix++) for (let iz = cellZ - 1; iz <= cellZ + 1; iz++) {
                for (const direction of directions.get(`${best.class}/${ix},${iz}`) ?? []) {
                    const d = Math.hypot(direction.x - x, direction.z - z);
                    if (d < distance) { distance = d; tx = direction.dx; tz = direction.dz; }
                }
            }
            best.tangentX = tx; best.tangentZ = tz;
            best.longitudinalSlope = -(best.normal.x * tx + best.normal.z * tz) / best.normal.y;
            const rawCross = (best.normal.x * tz - best.normal.z * tx) / best.normal.y;
            best.crossSlope = Math.max(-BANK_LIMIT[best.class], Math.min(BANK_LIMIT[best.class], rawCross));
            // The rendered mesh remains the source of height and longitudinal
            // grade, while the driving normal applies the measured, class-based
            // banking limit. This keeps wheel contacts stable on steep MDT cuts.
            const side = best.crossSlope;
            const along = best.longitudinalSlope;
            best.normal = new Vector3(-along * tx + side * tz, 1, -along * tz - side * tx).normalize();
        }
        return best;
    };
    return { sampleAt, heightAt: (x, z) => sampleAt(x, z)?.height ?? terrain.heightAt(x, z), normalAt: (x, z, out) => { const n = sampleAt(x, z)?.normal ?? terrain.normalAt(x, z); return out ? out.copyFrom(n) : n; } };
}
