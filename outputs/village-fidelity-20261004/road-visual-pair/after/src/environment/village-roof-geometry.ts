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
