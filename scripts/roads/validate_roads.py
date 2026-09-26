#!/usr/bin/env python3
"""Validacion cruzada de los entregables de la FASE 3a.

No reutiliza la logica de build_roads.py: recalcula longitudes, grafo y
alcance desde cero a partir de los archivos PUBLICADOS y compara contra
stats.json. Si algo no cierra, sale con codigo != 0.

Uso:
    .venv/bin/python scripts/roads/validate_roads.py
"""
from __future__ import annotations

import json
import math
import sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "public" / "roads"

FAILS: list[str] = []
CHECKS = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global CHECKS
    CHECKS += 1
    status = "OK  " if ok else "FAIL"
    print(f"[{status}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        FAILS.append(name)


def orient(a: list[float], b: list[float], c: list[float]) -> float:
    return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])


def point_strictly_inside(point: list[float], ring: list[list[float]]) -> bool:
    x, y = point
    inside = False
    for a, b in zip(ring, ring[1:] + ring[:1]):
        if (a[1] > y) != (b[1] > y):
            cross_x = a[0] + (y - a[1]) * (b[0] - a[0]) / (b[1] - a[1])
            if x < cross_x:
                inside = not inside
    return inside


def proper_segments_cross(a: list[float], b: list[float], c: list[float], d: list[float]) -> bool:
    eps = 1e-8
    ab_c, ab_d = orient(a, b, c), orient(a, b, d)
    cd_a, cd_b = orient(c, d, a), orient(c, d, b)
    return ((ab_c > eps and ab_d < -eps) or (ab_c < -eps and ab_d > eps)) and (
        (cd_a > eps and cd_b < -eps) or (cd_a < -eps and cd_b > eps)
    )


def segment_crosses_footprint(a: list[float], b: list[float], ring: list[list[float]]) -> bool:
    midpoint = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
    if point_strictly_inside(a, ring) or point_strictly_inside(b, ring) or point_strictly_inside(midpoint, ring):
        return True
    return any(proper_segments_cross(a, b, c, d)
               for c, d in zip(ring, ring[1:] + ring[:1]))

# --- Banda dibujada (clearance): mismos primitivos, sin dependencias nuevas --
RENDER_SUBDIVISION_M = 2.5  # DEBE coincidir con DRAPING.subdivisionM
ZERO_EPS = 1e-9


def render_stations(points, max_step):
    """Replica `resamplePolyline` del renderer: por tramo, ceil(len/maxStep).

    Conserva los vertices originales y acumula `t` (distancia desde el inicio).
    """
    out = []
    total = 0.0

    def push(x, z, t):
        if out and abs(out[-1][0] - x) < 1e-6 and abs(out[-1][1] - z) < 1e-6:
            return
        out.append((x, z, t))

    if len(points) < 2 or max_step <= 0:
        return out
    push(points[0][0], points[0][1], 0.0)
    for i in range(1, len(points)):
        ax, az = points[i - 1][0], points[i - 1][1]
        bx, bz = points[i][0], points[i][1]
        seg = math.hypot(bx - ax, bz - az)
        if seg < 1e-9:
            continue
        steps = max(1, math.ceil(seg / max_step))
        for k in range(1, steps + 1):
            f = k / steps
            push(ax + (bx - ax) * f, az + (bz - az) * f, total + seg * f)
        total += seg
    return out


def station_normals(stations):
    """Normal izquierda por estacion (promedio de vecinos, igual que el renderer)."""
    n = len(stations)
    out = []
    for i, (x, z, t) in enumerate(stations):
        prev = stations[max(0, i - 1)]
        nxt = stations[min(n - 1, i + 1)]
        dx, dz = nxt[0] - prev[0], nxt[1] - prev[1]
        dist = math.hypot(dx, dz)
        if dist < 1e-9:
            nx, nz = 0.0, 0.0
        else:
            nx, nz = -dz / dist, dx / dist
        out.append((x, z, t, nx, nz))
    return out


def profile_at(arrays, t):
    """Interpola (bandLeft, bandRight) por distancia acumulada."""
    step = arrays["stepM"]
    left, right = arrays["bandLeft"], arrays["bandRight"]
    last = len(left) - 1
    pos = max(0.0, t) / step
    i0 = int(math.floor(pos))
    if i0 >= last:
        return left[last], right[last]
    f = pos - i0
    return (left[i0] * (1 - f) + left[i0 + 1] * f,
            right[i0] * (1 - f) + right[i0 + 1] * f)


def point_in_triangle_strict(p, a, b, c):
    eps = 1e-9
    d1, d2, d3 = orient(p, a, b), orient(p, b, c), orient(p, c, a)
    return (d1 > eps and d2 > eps and d3 > eps) or (d1 < -eps and d2 < -eps and d3 < -eps)


def triangle_crosses_footprint(tri, ring, ring_edges):
    a, b, c = tri
    if point_strictly_inside(a, ring) or point_strictly_inside(b, ring) or point_strictly_inside(c, ring):
        return True
    mid = [(a[0] + b[0] + c[0]) / 3.0, (a[1] + b[1] + c[1]) / 3.0]
    if point_strictly_inside(mid, ring):
        return True
    for p in ring:
        if point_in_triangle_strict(p, a, b, c):
            return True
    for e0, e1 in ((a, b), (b, c), (c, a)):
        for r0, r1 in ring_edges:
            if proper_segments_cross(e0, e1, r0, r1):
                return True
    return False



def main() -> int:
    roads_doc = json.loads((OUT / "roads.json").read_text(encoding="utf-8"))
    buildings_doc = json.loads((ROOT / "public" / "village" / "buildings.json").read_text(encoding="utf-8"))
    nav = json.loads((OUT / "navigation.json").read_text(encoding="utf-8"))
    stats = json.loads((OUT / "stats.json").read_text(encoding="utf-8"))
    roads = roads_doc["roads"]
    nodes, edges, meta = nav["nodes"], nav["edges"], nav["edgeMeta"]

    # --- 1. esquema de roads.json -----------------------------------------
    bad = [r["id"] for r in roads
           if not ({"id", "class", "kind", "width", "speedFactor", "points", "tags"} <= set(r))]
    check("roads: esquema basico completo", not bad, f"{len(bad)} incompletos")

    ids = [r["id"] for r in roads]
    check("roads: ids unicos", len(ids) == len(set(ids)), f"{len(ids)} segmentos")

    fuera = [r["id"] for r in roads
             if any(not (0 <= p[0] <= 6000 and 0 <= p[1] <= 6000) for p in r["points"])]
    check("roads: toda coordenada dentro de la ventana 6000x6000", not fuera,
          f"{len(fuera)} fuera")

    long_err = []
    for r in roads:
        L = sum(math.hypot(b[0] - a[0], b[1] - a[1]) for a, b in zip(r["points"], r["points"][1:]))
        if abs(L - r["length"]) > 0.02:
            long_err.append((r["id"], round(L, 2), r["length"]))
    check("roads: length == largo de la polilinea", not long_err, f"{len(long_err)} descuadres")

    clases = {"ROAD", "TRACK", "PATH"}
    check("roads: class en el enum", all(r["class"] in clases for r in roads))
    check("roads: width > 0", all(r["width"] > 0 for r in roads))
    check("roads: speedFactor en (0,1]", all(0 < r["speedFactor"] <= 1 for r in roads))
    check("roads: tags crudos preservados", all(isinstance(r["tags"], dict) and r["tags"]
                                                for r in roads))
    polygonal_walkways = [r["id"] for r in roads
                          if len(r["points"]) >= 4
                          and r["points"][0] == r["points"][-1]
                          and (r["tags"].get("area") == "yes"
                               or "area:highway" in r["tags"]
                               or (r["tags"].get("highway") in {"path", "footway", "bridleway",
                                                                  "cycleway", "steps", "pedestrian"}
                                   and r["tags"].get("place") == "square"))]
    check("roads: areas peatonales no se dibujan como lineas", not polygonal_walkways,
          f"{len(polygonal_walkways)} areas incluidas como vias")
    check("stats: areas peatonales excluidas quedan trazadas",
          "area_feature" in stats["excluded"]["by_reason"],
          str(stats["excluded"]["by_reason"].get("area_feature", {})))
    check("roads: TRACK conserva tracktype", all(r["tracktype"] for r in roads
                                                 if r["class"] == "TRACK" and
                                                 r["tags"].get("tracktype")))

    road_building_crossings = []
    footprints = []
    for building in buildings_doc["buildings"]:
        ring = building["footprint"]
        footprints.append((building["id"], ring, list(zip(ring, ring[1:] + ring[:1])),
                           min(point[0] for point in ring), min(point[1] for point in ring),
                           max(point[0] for point in ring), max(point[1] for point in ring)))
    for road in roads:
        for a, b in zip(road["points"], road["points"][1:]):
            seg_min_x, seg_max_x = min(a[0], b[0]), max(a[0], b[0])
            seg_min_y, seg_max_y = min(a[1], b[1]), max(a[1], b[1])
            for building_id, ring, _ring_edges, min_x, min_y, max_x, max_y in footprints:
                if seg_max_x < min_x or seg_min_x > max_x or seg_max_y < min_y or seg_min_y > max_y:
                    continue
                if segment_crosses_footprint(a, b, ring):
                    road_building_crossings.append((road["id"], building_id))
                    break
    check("roads: polilineas no atraviesan huellas de edificios",
          not road_building_crossings,
          f"{len(road_building_crossings)} tramos; muestra={road_building_crossings[:5]}")
    # --- 1b. clearance: esquema y valores del perfil publicado --------------
    EXPECTED_CLEAR_KEYS = {"stepM", "renderStepM", "skirtM", "bandLeft", "bandRight"}
    profiled = [r for r in roads if r.get("clearance") is not None]
    bad_clear_keys = [r["id"] for r in profiled if set(r["clearance"]) != EXPECTED_CLEAR_KEYS]
    check("clearance: esquema {stepM,renderStepM,skirtM,bandLeft,bandRight}",
          not bad_clear_keys, f"{len(bad_clear_keys)} con claves raras")

    clear_schema_err = []
    clear_len_err = []
    clear_bound_err = []
    clear_steps = set()
    fully_zero_recomputed = []
    zero_intervals_recomputed = 0
    for r in profiled:
        cl = r["clearance"]
        try:
            step, rstep, skirt = cl["stepM"], cl["renderStepM"], cl["skirtM"]
            left, right = cl["bandLeft"], cl["bandRight"]
        except (KeyError, TypeError):
            clear_schema_err.append(r["id"])
            continue
        if (not isinstance(left, list) or not isinstance(right, list)
                or len(left) < 2 or len(left) != len(right)
                or not all(isinstance(v, (int, float)) and math.isfinite(v)
                           for v in [step, rstep, skirt] + left + right)):
            clear_schema_err.append(r["id"])
            continue
        exp_skirt = 0.6 if (r["class"] == "ROAD" and not r.get("bridge", False)) else 0.0
        if not (step > 0 and rstep > 0) or skirt < 0 or abs(skirt - exp_skirt) > 1e-9:
            clear_schema_err.append((r["id"], step, rstep, skirt))
            continue
        if rstep > RENDER_SUBDIVISION_M + 1e-9:
            clear_schema_err.append((r["id"], f"renderStepM={rstep}>2.5"))
            continue
        clear_steps.add((step, rstep, skirt))
        L = sum(math.hypot(b[0] - a[0], b[1] - a[1]) for a, b in zip(r["points"], r["points"][1:]))
        n = int(math.floor(L / step + 1e-9))
        exp_n = n + 1 + (1 if n * step < L - 1e-9 else 0)
        if len(left) != exp_n:
            clear_len_err.append((r["id"], len(left), exp_n))
        half = r["width"] / 2.0
        outer = half + skirt
        for v in left + right:
            if not (-1e-12 <= v <= outer + 1e-6):
                clear_bound_err.append((r["id"], v))
                break
            pav = max(0.0, min(half, v - skirt))  # calzada derivada; el resto es faldon
            if not (0.0 <= pav <= half + 1e-9):
                clear_bound_err.append((r["id"], f"pav={pav}"))
                break
        if all(v <= ZERO_EPS for v in left + right):
            fully_zero_recomputed.append(r["id"])
        for side in (left, right):
            in_run = False
            for v in side:
                if v <= ZERO_EPS and not in_run:
                    in_run = True
                    zero_intervals_recomputed += 1
                elif v > ZERO_EPS:
                    in_run = False
    check("clearance: step/renderStep/skirt validos y renderStepM<=2.5m",
          not clear_schema_err,
          f"{len(clear_schema_err)} errores; pasos={sorted(clear_steps)}; muestra={clear_schema_err[:5]}")
    check("clearance: longitudes bandLeft/bandRight == estaciones del perfil",
          not clear_len_err, f"{len(clear_len_err)} descuadres; muestra={clear_len_err[:5]}")
    check("clearance: 0<=banda<=width/2+skirt y calzada+faldon coherente",
          not clear_bound_err, f"{len(clear_bound_err)} fuera de cota; muestra={clear_bound_err[:5]}")

    # --- 1c. banda dibujada (calzada+faldon) vs huellas ----------------------
    band_overlaps = []
    for road in roads:
        cl = road.get("clearance")
        half = road["width"] / 2.0
        if cl is not None:
            step = cl["renderStepM"]
            skirt = cl["skirtM"]
            arrays = {"stepM": cl["stepM"], "bandLeft": cl["bandLeft"], "bandRight": cl["bandRight"]}
        else:
            step = RENDER_SUBDIVISION_M
            skirt = 0.6 if (road["class"] == "ROAD" and not road.get("bridge", False)) else 0.0
            arrays = None
        outer = half + skirt
        if outer <= 0:
            continue
        pts = road["points"]
        rminx = min(p[0] for p in pts) - outer
        rmaxx = max(p[0] for p in pts) + outer
        rminy = min(p[1] for p in pts) - outer
        rmaxy = max(p[1] for p in pts) + outer
        cands = [(fbid, fring, fedges, fx0, fy0, fx1, fy1)
                 for (fbid, fring, fedges, fx0, fy0, fx1, fy1) in footprints
                 if not (rmaxx < fx0 or rminx > fx1 or rmaxy < fy0 or rminy > fy1)]
        if not cands:
            continue
        stations = station_normals(render_stations(pts, step))
        if len(stations) < 2:
            continue
        if arrays is not None:
            widths = [profile_at(arrays, t) for (_x, _z, t, _nx, _nz) in stations]
        else:
            widths = [(outer, outer)] * len(stations)
        hit = None
        for i in range(len(stations) - 1):
            x0, z0, _t0, nx0, nz0 = stations[i]
            x1, z1, _t1, nx1, nz1 = stations[i + 1]
            hl0, hr0 = widths[i]
            hl1, hr1 = widths[i + 1]
            corners = ((x0 + nx0 * hl0, z0 + nz0 * hl0),
                       (x0 - nx0 * hr0, z0 - nz0 * hr0),
                       (x1 - nx1 * hr1, z1 - nz1 * hr1),
                       (x1 + nx1 * hl1, z1 + nz1 * hl1))
            if len(set(corners)) < 4:
                continue
            for tri in ((corners[0], corners[1], corners[2]), (corners[0], corners[2], corners[3])):
                if abs(orient(tri[0], tri[1], tri[2])) / 2.0 <= 1e-12:
                    continue
                tminx = min(p[0] for p in tri)
                tmaxx = max(p[0] for p in tri)
                tminy = min(p[1] for p in tri)
                tmaxy = max(p[1] for p in tri)
                for fbid, fring, fedges, fx0, fy0, fx1, fy1 in cands:
                    if tmaxx < fx0 or tminx > fx1 or tmaxy < fy0 or tminy > fy1:
                        continue
                    if triangle_crosses_footprint(tri, fring, fedges):
                        hit = (road["id"], fbid)
                        break
                if hit is not None:
                    break
            if hit is not None:
                break
        if hit is not None:
            band_overlaps.append(hit)
    check("clearance: banda exterior (calzada+faldon) no invade huellas",
          not band_overlaps,
          f"{len(band_overlaps)} pares; muestra={band_overlaps[:5]}")


    # --- 2. esquema de navigation.json ------------------------------------
    check("nav: nodes/edges/edgeMeta paralelos",
          len(edges) == len(meta), f"{len(edges)} aristas / {len(meta)} meta")
    idx_ok = all(0 <= a < len(nodes) and 0 <= b < len(nodes) for a, b in edges)
    check("nav: indices de arista validos", idx_ok)

    len_err = []
    for (a, b), m in zip(edges, meta):
        d = math.hypot(nodes[a][0] - nodes[b][0], nodes[a][1] - nodes[b][1])
        if abs(d - m["length"]) > 0.006:
            len_err.append((a, b, round(d, 4), m["length"]))
    check("nav: edgeMeta.length == hypot(nodos)", not len_err, f"{len(len_err)} descuadres")

    fuera_n = [i for i, p in enumerate(nodes)
               if not (0 <= p[0] <= 6000 and 0 <= p[1] <= 6000)]
    check("nav: nodos dentro de la ventana", not fuera_n, f"{len(fuera_n)} fuera")

    # --- 3. roads.json <-> navigation.json --------------------------------
    pair_set = {frozenset((tuple(nodes[a]), tuple(nodes[b]))) for a, b in edges}
    node_set = {(p[0], p[1]) for p in nodes}
    missing_node = []
    missing_edge = []
    for r in roads:
        for p in r["points"]:
            if (p[0], p[1]) not in node_set:
                missing_node.append(r["id"])
                break
        for a, b in zip(r["points"], r["points"][1:]):
            if frozenset(((a[0], a[1]), (b[0], b[1]))) not in pair_set:
                missing_edge.append(r["id"])
                break
    check("grafo: todo vertice de roads existe como nodo", not missing_node,
          f"{len(set(missing_node))} vias con vertices huerfanos")
    check("grafo: todo tramo de roads existe como arista", not missing_edge,
          f"{len(set(missing_edge))} vias con tramos sin arista")

    # --- 4. km contra stats.json ------------------------------------------
    km = defaultdict(float)
    for r in roads:
        km[r["class"]] += r["length"] / 1000.0
    deltas = {c: abs(round(km[c], 3) - stats["length_km"]["by_class"][c])
              for c in clases}
    check("stats: km por clase == suma de roads.json", all(d <= 0.01 for d in deltas.values()),
          f"deltas={deltas} km_reales={ {c: round(km[c], 3) for c in clases} }")

    tt = defaultdict(float)
    for r in roads:
        if r["class"] == "TRACK":
            tt[r["tracktype"] or "sin_tracktype"] += r["length"] / 1000.0
    deltas_tt = {k: abs(round(v, 3) - stats["length_km"]["by_tracktype"].get(k, 0.0))
                 for k, v in tt.items()}
    check("stats: km por tracktype == suma de roads.json",
          all(d <= 0.01 for d in deltas_tt.values()) and len(tt) > 0,
          f"deltas={deltas_tt} km_reales={ {k: round(v, 3) for k, v in tt.items()} }")

    check("stats: conteo de ways", stats["counts"]["ways_downloaded"] == 469,
          f"{stats['counts']['ways_downloaded']} bajados")

    # --- 5. alcance recalculado desde cero --------------------------------
    adj: dict[int, list[tuple[int, int]]] = defaultdict(list)
    for ei, (a, b) in enumerate(edges):
        adj[a].append((b, ei))
        adj[b].append((a, ei))

    spawn = stats["connectivity"]["spawn_world"]
    # arista mas cercana al arranque (recalculo independiente)
    best_d, best_e = math.inf, None
    for ei, (a, b) in enumerate(edges):
        ax, az = nodes[a]
        bx, bz = nodes[b]
        dx, dz = bx - ax, bz - az
        den = dx * dx + dz * dz
        t = 0.0 if den == 0 else max(0.0, min(1.0, ((spawn[0] - ax) * dx + (spawn[1] - az) * dz) / den))
        d = math.hypot(spawn[0] - (ax + dx * t), spawn[1] - (az + dz * t))
        if d < best_d:
            best_d, best_e = d, ei
    a, b = edges[best_e]
    check("conectividad: distancia al arista mas cercana",
          abs(round(best_d, 2) - stats["connectivity"]["spawn_nearest_edge"]["distance_m"]) <= 0.02,
          f"{round(best_d, 2)} m")

    def reached_km(allowed: set[str]) -> dict[str, float]:
        seen_nodes = {a, b}
        stack = [a, b]
        used_edges: set[int] = set()
        while stack:
            v = stack.pop()
            for nb, ei in adj[v]:
                if meta[ei]["class"] not in allowed:
                    continue
                used_edges.add(ei)
                if nb not in seen_nodes:
                    seen_nodes.add(nb)
                    stack.append(nb)
        # arista cuenta si ambos extremos quedaron alcanzados
        out = defaultdict(float)
        for ei in used_edges:
            x, y = edges[ei]
            if x in seen_nodes and y in seen_nodes and meta[ei]["class"] in allowed:
                out[meta[ei]["class"]] += meta[ei]["length"] / 1000.0
        return out

    for variant, allowed in (
        ("todas_las_clases", {"ROAD", "TRACK", "PATH"}),
        ("solo_rodables_ROAD_TRACK", {"ROAD", "TRACK"}),
    ):
        got = reached_km(allowed)
        exp = stats["connectivity"]["variants"][variant]["km_by_class"]
        delta = {c: abs(round(got.get(c, 0.0), 3) - exp.get(c, 0.0)) for c in allowed}
        check(f"conectividad: km alcanzados ({variant})",
              all(d <= 0.02 for d in delta.values()),
              f"deltas={delta} alcanzados={ {c: round(got.get(c, 0.0), 3) for c in allowed} }")

    # --- 6. validaciones de cobertura -------------------------------------
    cov = stats["coverage"]
    check("cobertura: 0 endpoints interiores no originales",
          cov["interior_endpoints_not_original_vertex"] == 0,
          f"{cov['interior_endpoints_not_original_vertex']}")
    check("cobertura: ningun vertice fuera de la ventana",
          cov["max_vertex_outside_window_m"] == 0.0)
    check("cobertura: auditoria de buffer OK",
          cov["audit_buffer"] is None or cov["audit_buffer"]["coverage_ok"] is True)
    check("cobertura: geometria de TRACK en el cuadrante noreste",
          cov["quadrant_km_northeast_x>=3000_z>=3000"]["TRACK"] > 0,
          f"{cov['quadrant_km_northeast_x>=3000_z>=3000']['TRACK']} km")
    ne_cells = [c for row in cov["grid_1km_km"] for c in row
                if c["x"] >= 3000 and c["z"] >= 3000]
    check("cobertura: las 9 celdas del cuadrante NE tienen TRACK",
          all(c["TRACK"] > 0 for c in ne_cells),
          f"{sum(1 for c in ne_cells if c['TRACK'] > 0)}/9")

    # --- 7. alcance minimo exigido ----------------------------------------
    pct = stats["connectivity"]["variants"]["todas_las_clases"]["track_pct_reached"]
    check("conectividad: >= 95% de TRACK alcanzable desde Villafranca", pct >= 95.0,
          f"{pct}%")


    # --- 8. invariantes de la corrida con clearance --------------------------
    check("roads: 436 ejes publicados", len(roads) == 436, f"{len(roads)} segmentos")
    check("stats: segments_kept == ejes publicados",
          stats["counts"]["segments_kept"] == len(roads),
          f"kept={stats['counts']['segments_kept']}")
    check("nav: sin cambios (nodos/aristas de stats)",
          len(nodes) == stats["graph"]["nodes"] and len(edges) == stats["graph"]["edges"],
          f"nodos={len(nodes)}/{stats['graph']['nodes']} aristas={len(edges)}/{stats['graph']['edges']}")
    fc = stats.get("footprint_clearance", {})
    check("stats: footprint_clearance trae before/after/hidden_runs",
          isinstance(fc, dict) and isinstance(fc.get("before"), dict)
          and isinstance(fc.get("after"), dict) and isinstance(fc.get("hidden_runs"), list),
          f"claves={sorted(fc)[:6] if isinstance(fc, dict) else None}")
    after = fc.get("after", {}) if isinstance(fc, dict) else {}
    runs = fc.get("hidden_runs", []) if isinstance(fc, dict) else []
    check("clearance: after == 0 pares/edificios y banda dibujada sin solape",
          after.get("pairs", -1) == 0 and after.get("buildings", -1) == 0 and not band_overlaps,
          f"after={after.get('pairs')}/{after.get('buildings')} banda={len(band_overlaps)}")
    check("clearance: vias recortadas == perfiles publicados",
          fc.get("clamped_roads", -1) == len(profiled),
          f"clamped={fc.get('clamped_roads')} perfiles={len(profiled)}")
    check("clearance: ninguna via entera con banda cero",
          fc.get("roads_fully_zero_band", None) == [] and not fully_zero_recomputed,
          f"stats={fc.get('roads_fully_zero_band')} recalculadas={fully_zero_recomputed[:5]}")
    runs_ok = (
        isinstance(runs, list)
        and sum(r.get("stations", -1) for r in runs) == fc.get("hidden_stations", -2)
        and sum(r.get("holgura_stations", -1) for r in runs) == fc.get("hidden_holgura_stations", -2)
        and sum(r.get("refinado_stations", -1) for r in runs) == fc.get("hidden_refinado_stations", -2)
        and sorted({r.get("road") for r in runs}) == list(fc.get("hidden_roads", []))
        and all(set(r) >= {"road", "class", "side", "t0_m", "t1_m", "length_m", "stations", "reason"}
                and r.get("reason") in {"holgura", "refinado"}
                and r.get("side") in {"left", "right"} for r in runs)
    )
    check("clearance: hidden_runs cuantificados en stats",
          runs_ok,
          f"{len(runs)} runs en {len(fc.get('hidden_roads', []))} vias; "
          f"refinado={fc.get('hidden_refinado_stations')}; "
          f"recalculados={zero_intervals_recomputed} intervalos cero; "
          f"muestra={runs[:2] if isinstance(runs, list) else None}")

    print(f"\n{CHECKS - len(FAILS)}/{CHECKS} checks OK")
    if FAILS:
        print("FALLAS:")
        for f in FAILS:
            print(f"  - {f}")
        return 1
    print("TODO OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
