export type RoofPoint = readonly [number, number];
export type RoofTriangle = readonly [readonly [number, number, number], readonly [number, number, number], readonly [number, number, number]];

export interface HipRoofSurfaceOptions {
  readonly center: RoofPoint;
  readonly axis: RoofPoint;
  readonly halfU: number;
  readonly halfV: number;
  readonly ridgeHalfU: number;
  readonly topY: number;
  readonly drop: number;
}

/** Ear-clips a simple polygon, then partitions each ear along the exact
 * piecewise-linear creases of a clipped hip roof. Concave source boundaries are
 * retained: every output XY triangle stays within its source ear/polygon. */
export function triangulateHipRoof(polygon: readonly RoofPoint[], o: HipRoofSurfaceOptions): RoofTriangle[] {
  const u = o.axis;
  const v: RoofPoint = [-u[1], u[0]];
  const lines: ((p: RoofPoint) => number)[] = [];
  const addU = (at: number) => lines.push(p => dot(sub(p, o.center), u) - at);
  const addV = (at: number) => lines.push(p => dot(sub(p, o.center), v) - at);
  addU(0); addU(o.ridgeHalfU); addU(-o.ridgeHalfU);
  addU(o.ridgeHalfU + o.halfV); addU(-o.ridgeHalfU - o.halfV);
  addV(0); addV(o.halfV); addV(-o.halfV);
  // Equality creases where the end-hip plane becomes the side-hip plane.
  for (const su of [-1, 1]) for (const sv of [-1, 1]) {
    lines.push(p => sv * dot(sub(p, o.center), v) - su * dot(sub(p, o.center), u) + o.ridgeHalfU);
  }

  return triangulatePartitioned(polygon, lines, p => hipRoofHeight(p, o));
}

export interface GableRoofSurfaceOptions {
  readonly center: RoofPoint;
  readonly axis: RoofPoint;
  readonly halfV: number;
  readonly eaveY: number;
  readonly rise: number;
}

/** Triangulate a gable as a continuous, piecewise-linear roof clipped to its footprint. */
export function triangulateGableRoof(polygon: readonly RoofPoint[], o: GableRoofSurfaceOptions): RoofTriangle[] {
  const v: RoofPoint = [-o.axis[1], o.axis[0]];
  const projectV = (p: RoofPoint): number => dot(sub(p, o.center), v);
  const lines = [-o.halfV, 0, o.halfV].map(at => (p: RoofPoint) => projectV(p) - at);
  const height = (p: RoofPoint): number => o.eaveY + o.rise * (1 - Math.min(1, Math.abs(projectV(p)) / Math.max(o.halfV, 1e-3)));
  return triangulatePartitioned(polygon, lines, height);
}

export interface GlazingPatchOptions {
  readonly uMin: number;
  readonly uMax: number;
  readonly vMin: number;
  readonly vMax: number;
  readonly roofKind?: 'teja' | 'chapa' | 'pizarra' | undefined;
  readonly roofTint?: readonly [number, number, number] | undefined;
}

export interface CompoundRoofWing {
  readonly name: string;
  readonly polygon: readonly RoofPoint[];
  readonly roofShape?: 'hip' | 'gable' | undefined;
  readonly roofKind?: 'teja' | 'chapa' | 'pizarra' | undefined;
  readonly roofTint?: readonly [number, number, number] | undefined;
  readonly ridgeRadians?: number | undefined;
  readonly glazingPatch?: GlazingPatchOptions | undefined;
}

export interface CompoundRoofOptions {
  readonly polygon: readonly RoofPoint[];
  readonly wings: readonly CompoundRoofWing[];
  readonly topY: number;
}

export interface CompoundRoofWingSurface {
  readonly name: string;
  readonly roofKind: 'teja' | 'chapa' | 'pizarra';
  readonly roofTint?: readonly [number, number, number] | undefined;
  readonly triangles: readonly RoofTriangle[];
}

export interface CompoundRoofSurface {
  readonly triangles: readonly RoofTriangle[];
  readonly wings: readonly CompoundRoofWingSurface[];
  readonly heightAt: (p: RoofPoint) => number;
}

export function inside(p: readonly RoofPoint[], x: number, z: number): boolean {
  let hit = false;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const a = p[i]!, b = p[j]!, dx = b[0] - a[0], dz = b[1] - a[1];
    const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / (dx * dx + dz * dz || 1)));
    if (Math.hypot(x - (a[0] + dx * t), z - (a[1] + dz * t)) < 1e-6) return true;
    if ((a[1] > z) !== (b[1] > z) && x < (b[0] - a[0]) * (z - a[1]) / (b[1] - a[1]) + a[0]) hit = !hit;
  }
  return hit;
}

export function triangulateCompoundRoof(o: CompoundRoofOptions): CompoundRoofSurface {
  const allTriangles: RoofTriangle[] = [];
  const wingsResult: CompoundRoofWingSurface[] = [];

  const wingEvaluators: {
    readonly wing: CompoundRoofWing;
    readonly heightAt: (p: RoofPoint) => number;
    readonly center: RoofPoint;
  }[] = [];

  for (const wing of o.wings) {
    const twiceArea = wing.polygon.reduce((sum, a, i) => {
      const b = wing.polygon[(i + 1) % wing.polygon.length]!;
      return sum + a[0] * b[1] - b[0] * a[1];
    }, 0);
    const signed = twiceArea / 2;
    let cx = 0, cz = 0;
    for (let i = 0; i < wing.polygon.length; i++) {
      const a = wing.polygon[i]!, b = wing.polygon[(i + 1) % wing.polygon.length]!;
      const crossVal = a[0] * b[1] - b[0] * a[1];
      cx += (a[0] + b[0]) * crossVal;
      cz += (a[1] + b[1]) * crossVal;
    }
    const center: RoofPoint = [cx / (6 * signed), cz / (6 * signed)];
    let axis: RoofPoint;
    if (wing.ridgeRadians !== undefined) {
      axis = [Math.cos(wing.ridgeRadians), Math.sin(wing.ridgeRadians)];
    } else {
      let cxx = 0, czz = 0, cxz = 0;
      for (const p of wing.polygon) {
        cxx += (p[0] - center[0]) ** 2;
        czz += (p[1] - center[1]) ** 2;
        cxz += (p[0] - center[0]) * (p[1] - center[1]);
      }
      const theta = 0.5 * Math.atan2(2 * cxz, cxx - czz);
      axis = [Math.cos(theta), Math.sin(theta)];
    }

    let halfU = 0, halfV = 0;
    for (const p of wing.polygon) {
      const dx = p[0] - center[0], dz = p[1] - center[1];
      halfU = Math.max(halfU, Math.abs(dx * axis[0] + dz * axis[1]));
      halfV = Math.max(halfV, Math.abs(-dx * axis[1] + dz * axis[0]));
    }

    const u = axis;
    const v: RoofPoint = [-u[1], u[0]];
    const uMin = wing.glazingPatch?.uMin;
    const uMax = wing.glazingPatch?.uMax;
    const vMin = wing.glazingPatch?.vMin;
    const vMax = wing.glazingPatch?.vMax;

    if (wing.roofShape === 'gable') {
      const rise = Math.min(Math.max(0.25 * (2 * halfV), 0.4), 3);
      const projectV = (p: RoofPoint): number => dot(sub(p, center), v);
      const lines = [-halfV, 0, halfV].map(at => (p: RoofPoint) => projectV(p) - at);
      const height = (p: RoofPoint): number => o.topY - rise * (Math.abs(projectV(p)) / Math.max(halfV, 1e-3));
      wingEvaluators.push({ wing, heightAt: height, center });
      const tris = triangulatePartitioned(wing.polygon, lines, height);
      allTriangles.push(...tris);
      wingsResult.push({
        name: wing.name,
        roofKind: wing.roofKind ?? 'teja',
        roofTint: wing.roofTint,
        triangles: tris,
      });
    } else {
      const ridgeHalfU = Math.max(0, halfU - halfV);
      const drop = Math.min(Math.max(0.45 * Math.min(halfU, halfV), 0.5), 2.2);
      const hipOpts: HipRoofSurfaceOptions = { center, axis, halfU, halfV, ridgeHalfU, topY: o.topY, drop };
      const lines: ((p: RoofPoint) => number)[] = [];
      const addU = (at: number) => lines.push(p => dot(sub(p, center), u) - at);
      const addV = (at: number) => lines.push(p => dot(sub(p, center), v) - at);
      addU(0); addU(ridgeHalfU); addU(-ridgeHalfU);
      addU(ridgeHalfU + halfV); addU(-ridgeHalfU - halfV);
      addV(0); addV(halfV); addV(-halfV);
      for (const su of [-1, 1]) for (const sv of [-1, 1]) {
        lines.push(p => sv * dot(sub(p, center), v) - su * dot(sub(p, center), u) + ridgeHalfU);
      }
      if (wing.glazingPatch) {
        addU(wing.glazingPatch.uMin);
        addU(wing.glazingPatch.uMax);
        addV(wing.glazingPatch.vMin);
        addV(wing.glazingPatch.vMax);
      }
      const height = (p: RoofPoint): number => hipRoofHeight(p, hipOpts);
      wingEvaluators.push({ wing, heightAt: height, center });
      const tris = triangulatePartitioned(wing.polygon, lines, height);
      allTriangles.push(...tris);

      if (wing.glazingPatch && uMin !== undefined && uMax !== undefined && vMin !== undefined && vMax !== undefined) {
        const glazingTris: RoofTriangle[] = [];
        const mainTris: RoofTriangle[] = [];
        for (const tri of tris) {
          const [a, b, c] = tri;
          const cx = (a[0] + b[0] + c[0]) / 3;
          const cz = (a[2] + b[2] + c[2]) / 3;
          const cu = (cx - center[0]) * u[0] + (cz - center[1]) * u[1];
          const cv = -(cx - center[0]) * u[1] + (cz - center[1]) * u[0];
          if (cu >= uMin - 1e-4 && cu <= uMax + 1e-4 && cv >= vMin - 1e-4 && cv <= vMax + 1e-4) {
            glazingTris.push(tri);
          } else {
            mainTris.push(tri);
          }
        }
        wingsResult.push({
          name: `${wing.name}-main`,
          roofKind: wing.roofKind ?? 'teja',
          roofTint: wing.roofTint,
          triangles: mainTris,
        });
        wingsResult.push({
          name: `${wing.name}-glazing`,
          roofKind: wing.glazingPatch.roofKind ?? 'chapa',
          roofTint: wing.glazingPatch.roofTint,
          triangles: glazingTris,
        });
      } else {
        wingsResult.push({
          name: wing.name,
          roofKind: wing.roofKind ?? 'teja',
          roofTint: wing.roofTint,
          triangles: tris,
        });
      }
    }
  }

  const heightAt = (p: RoofPoint): number => {
    for (const ev of wingEvaluators) {
      if (inside(ev.wing.polygon, p[0], p[1])) return ev.heightAt(p);
    }
    let closestEv = wingEvaluators[0]!;
    let minDist = Infinity;
    for (const ev of wingEvaluators) {
      const dist = Math.hypot(p[0] - ev.center[0], p[1] - ev.center[1]);
      if (dist < minDist) {
        minDist = dist;
        closestEv = ev;
      }
    }
    return closestEv.heightAt(p);
  };

  return {
    triangles: allTriangles,
    wings: wingsResult,
    heightAt,
  };
}

function triangulatePartitioned(
  polygon: readonly RoofPoint[],
  lines: readonly ((p: RoofPoint) => number)[],
  heightAt: (p: RoofPoint) => number,
): RoofTriangle[] {
  const ears = earClip(polygon);
  const result: RoofTriangle[] = [];
  for (const ear of ears) {
    let cells: RoofPoint[][] = [[...ear]];
    for (const line of lines) {
      const next: RoofPoint[][] = [];
      for (const cell of cells) {
        const [positive, negative] = split(cell, line);
        if (positive.length >= 3 && area(positive) > 1e-8) next.push(positive);
        if (negative.length >= 3 && area(negative) > 1e-8) next.push(negative);
      }
      cells = next;
    }
    for (const cell of cells) {
      const p0 = cell[0]!;
      for (let i = 1; i + 1 < cell.length; i++) {
        const a = cell[i]!; const b = cell[i + 1]!;
        const tri = [vertex(p0, heightAt), vertex(a, heightAt), vertex(b, heightAt)] as const;
        if (Math.abs(cross(tri[0], tri[1], tri[2])) > 1e-8) result.push(tri);
      }
    }
  }
  return result;
}

export function hipRoofHeight(point: RoofPoint, o: HipRoofSurfaceOptions): number {
  const dx = point[0] - o.center[0], dz = point[1] - o.center[1];
  const u = dx * o.axis[0] + dz * o.axis[1];
  const v = dx * -o.axis[1] + dz * o.axis[0];
  const short = Math.abs(v) / Math.max(o.halfV, 1e-3);
  const end = Math.max(0, Math.abs(u) - o.ridgeHalfU) / Math.max(o.halfV, 1e-3);
  return o.topY - o.drop * Math.min(1, Math.max(short, end));
}

function vertex(p: RoofPoint, heightAt: (p: RoofPoint) => number): readonly [number, number, number] { return [p[0], heightAt(p), p[1]]; }
function sub(a: RoofPoint, b: RoofPoint): RoofPoint { return [a[0] - b[0], a[1] - b[1]]; }
function dot(a: RoofPoint, b: RoofPoint): number { return a[0] * b[0] + a[1] * b[1]; }
function cross(a: readonly number[], b: readonly number[], c: readonly number[]): number { return (b[0]! - a[0]!) * (c[2]! - a[2]!) - (b[2]! - a[2]!) * (c[0]! - a[0]!); }
function area(poly: readonly RoofPoint[]): number { let sum = 0; for (let i = 0; i < poly.length; i++) { const a = poly[i]!, b = poly[(i + 1) % poly.length]!; sum += a[0] * b[1] - b[0] * a[1]; } return Math.abs(sum / 2); }
function split(poly: readonly RoofPoint[], f: (p: RoofPoint) => number): [RoofPoint[], RoofPoint[]] {
  const out: [RoofPoint[], RoofPoint[]] = [[], []];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!, b = poly[(i + 1) % poly.length]!, fa = f(a), fb = f(b);
    if (fa >= -1e-8) out[0].push(a);
    if (fa <= 1e-8) out[1].push(a);
    if ((fa < -1e-8 && fb > 1e-8) || (fa > 1e-8 && fb < -1e-8)) {
      const t = fa / (fa - fb); const p: RoofPoint = [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
      out[0].push(p); out[1].push(p);
    }
  }
  return out.map(clean) as [RoofPoint[], RoofPoint[]];
}
function clean(poly: RoofPoint[]): RoofPoint[] { return poly.filter((p, i) => i === 0 || Math.hypot(p[0] - poly[i - 1]![0], p[1] - poly[i - 1]![1]) > 1e-7).filter((p, i, a) => i !== a.length - 1 || Math.hypot(p[0] - a[0]![0], p[1] - a[0]![1]) > 1e-7); }
function earClip(poly: readonly RoofPoint[]): RoofPoint[][] {
  const ccw = signedArea(poly) > 0; const ids = poly.map((_, i) => ccw ? i : poly.length - i - 1); const out: RoofPoint[][] = [];
  let guard = poly.length * poly.length;
  while (ids.length > 3 && guard-- > 0) {
    let found = false;
    for (let i = 0; i < ids.length; i++) {
      const ia = ids[(i + ids.length - 1) % ids.length]!, ib = ids[i]!, ic = ids[(i + 1) % ids.length]!;
      const a = poly[ia]!, b = poly[ib]!, c = poly[ic]!;
      if (orient(a, b, c) <= 1e-9) continue;
      if (ids.some(id => id !== ia && id !== ib && id !== ic && inTriangle(poly[id]!, a, b, c))) continue;
      out.push([a, b, c]); ids.splice(i, 1); found = true; break;
    }
    if (!found) throw new Error('Cannot ear-clip non-simple hip roof footprint');
  }
  if (ids.length === 3) out.push(ids.map(i => poly[i]!) as unknown as RoofPoint[]);
  return out;
}
function signedArea(p: readonly RoofPoint[]): number { let a = 0; for (let i = 0; i < p.length; i++) { const x = p[i]!, y = p[(i + 1) % p.length]!; a += x[0] * y[1] - y[0] * x[1]; } return a / 2; }
function orient(a: RoofPoint, b: RoofPoint, c: RoofPoint): number { return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]); }
function inTriangle(p: RoofPoint, a: RoofPoint, b: RoofPoint, c: RoofPoint): boolean { const x = orient(a, b, p), y = orient(b, c, p), z = orient(c, a, p); return x >= -1e-8 && y >= -1e-8 && z >= -1e-8; }
