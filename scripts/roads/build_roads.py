#!/usr/bin/env python3
"""Construye la red vial rural de la ventana jugable (FASE 3a — SOLO DATOS).

Entrada
    data/roads/raw/osm_highways_window.json           Overpass `out tags geom`
    data/roads/raw/osm_highways_window_manifest.json  SHA256 + URL + timestamp
    data/roads/raw/osm_highways_audit_buffer001.json  auditoria de cobertura
                                                      (buffer 0.01 deg, opcional)

Salida
    public/roads/roads.json       vias clasificadas, tags y geometria en
                                  coordenadas de mundo
    public/roads/navigation.json  grafo nodos/aristas para pathfinding
    public/roads/stats.json       km por clase, conectividad, cobertura

Pipeline
    1. proyeccion  WGS84 -> EPSG:25830 -> coords de mundo (origen sudoeste)
    2. recorte EXACTO a la ventana 6000 x 6000 m + verificacion de endpoints
    3. clasificacion off-road: ROAD / TRACK / PATH / EXCLUDE
    4. snap de extremos colgantes (<=1 m) y simplificacion que PROTEGE los
       vertices compartidos entre ways (si un cruce se simplificara, el grafo
       se romperia en silencio)
    5. grafo: un nodo por cada vertice, arista entre vertices consecutivos
       => la longitud de la arista ES el largo de la polilinea, asi que el
          RoadGraph del motor de referencia la consume sin traduccion
    6. validaciones: borde, cuadrante noreste, conectividad desde Villafranca

Regla del proyecto: los tags de OSM son METADATOS MAPEADOS, no mediciones.
Ancho y speedFactor son DISENO de gameplay, no dato. Ver docs/roads/.
"""
from __future__ import annotations

import argparse
import hashlib
import heapq
import json
import math
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

from pyproj import Transformer
from shapely.geometry import LineString, Point, Polygon, box
from shapely.strtree import STRtree

ROOT = Path(__file__).resolve().parents[2]
RAW_DIR = ROOT / "data" / "roads" / "raw"
OUT_DIR = ROOT / "public" / "roads"
BUILDINGS_PATH = ROOT / "public" / "village" / "buildings.json"

RAW_MAIN = RAW_DIR / "osm_highways_window.json"
RAW_MANIFEST = RAW_DIR / "osm_highways_window_manifest.json"
RAW_AUDIT = RAW_DIR / "osm_highways_audit_buffer001.json"

# --- Convencion de coordenadas (FIJA, no reinterpretar) ---------------------
E_MIN, E_MAX = 471500.0, 477500.0
N_MIN, N_MAX = 4689000.0, 4695000.0
E0, N0 = E_MIN, N_MIN          # origen del mundo = esquina SUDOESTE
WORLD_SIZE = 6000.0            # metros, worldScale = 1
SPAWN = (3097.0, 3945.0)       # Villafranca Montes de Oca, coords de mundo

# bbox viejo de data/geo/raw (YA NO SIRVE): corrido al sudoeste.
OLD_BBOX_WGS84 = (42.350651, -3.350784, 42.404549, -3.277816)  # S, W, N, E

# --- Parametros de construccion --------------------------------------------
SIMPLIFY_TOL_M = 1.0    # Douglas-Peucker; los vertices compartidos se salvan
SNAP_TOL_M = 1.0        # pegado de extremos colgantes que casi se tocan
TINY_SEG_M = 2.0        # umbral para CONTAR segmentos diminutos (no se borran)
PRECISION_M = 2         # decimales de metro (centimetros) en la salida

# --- CLASIFICACION OFF-ROAD -------------------------------------------------
ROAD_KINDS = {
    "trunk", "primary", "secondary", "tertiary",
    "unclassified", "residential", "living_street", "service",
    # Extension documentada: en la ventana no hay ninguna, pero si la hubiera
    # un motorway no puede quedar fuera de la red rodable.
    "motorway",
}
TRACK_KINDS = {"track"}
PATH_KINDS = {"path", "footway", "bridleway", "cycleway", "steps", "pedestrian"}
EXCLUDE_KINDS = {
    "proposed", "construction", "raceway", "escape", "ferry",
    "corridor", "via_ferrata", "rest_area", "services", "bus_stop",
    "platform", "proposed_link", "construction_link",
}

# --- Tablas de DISENO (estimacion, NO medicion) -----------------------------
ROAD_WIDTH_M = {
    "motorway": 7.5, "trunk": 7.5, "primary": 7.0, "secondary": 6.5,
    "tertiary": 6.0, "unclassified": 5.5, "residential": 5.5,
    "living_street": 5.0, "service": 4.5,
}
TRACK_WIDTH_M = {"grade1": 4.5, "grade2": 4.0, "grade3": 3.5, "grade4": 3.0, "grade5": 2.5}
TRACK_WIDTH_DEFAULT_M = 3.5
PATH_WIDTH_M = 1.5

ROAD_SPEED_FACTOR = 1.0
TRACK_SPEED_FACTOR = {"grade1": 0.60, "grade2": 0.50, "grade3": 0.42,
                      "grade4": 0.33, "grade5": 0.25}
TRACK_SPEED_FACTOR_DEFAULT = 0.45   # sin tracktype: centro cauteloso
PATH_SPEED_FACTOR = 0.10

# Desempate cuando dos ways comparten exactamente un tramo de geometria.
PRIORITY = {"ROAD": 0, "TRACK": 1, "PATH": 2}

# --- Banda renderizada vs huellas de edificios (H-000008) -------------------
# El renderer dibuja la calzada (width/2 por lado) mas, en ROAD sin puente, un
# faldon de SKIRT_WIDTH_M. Invasiones de huellas no se pueden juzgar con la
# linea central: hay que medir la banda exterior completa. Para no invadir
# huellas se publica un perfil de semiancho exterior ASIMETRICO por estacion
# (bandLeft/bandRight), recortado contra las huellas. Se busca la holgura
# CLEARANCE_MARGIN_M donde el ancho minimo legible lo permite; no es garantizada.
CLEARANCE_PROFILE_STEP_M = 1.0  # paso del perfil a lo largo de la via (m)
CLEARANCE_MARGIN_M = 0.30  # holgura preferida si el ancho visible lo permite (m)
CLEARANCE_MIN_FILTER_RADIUS = 1  # minimo movil en muestras (±1 m con paso 1 m)
# El renderer interpola el perfil entre DOS estaciones consecutivas resampleadas
# y esa interpolacion podria recuperar ancho. La garantia NO es analitica: la
# pasada `refine_profile` comprueba los triangulos EXACTOS del renderer sobre su
# mismo resample (segmento a segmento, `ceil(len/step)`), asi que
# CLEARANCE_RENDER_STEP_M fija la subdivision que el validador debe reproducir.
CLEARANCE_RENDER_STEP_M = 1.0  # <= RENDER_SUBDIVISION_M; DEBE coincidir con el renderer
RENDER_SUBDIVISION_M = 2.5  # DEBE coincidir con DRAPING.subdivisionM
SKIRT_WIDTH_M = 0.6  # DEBE coincidir con DRAPING.skirtWidthM
CLEARANCE_VISUAL_MIN_HALF_M = 0.5  # por debajo de esto la calzada es un hilo
CLEARANCE_NEAR_SPAWN_M = 300.0  # radio del informe "cerca del arranque"


# --------------------------------------------------------------------------
# Geometria
# --------------------------------------------------------------------------
def make_projector():
    tr = Transformer.from_crs("EPSG:4326", "EPSG:25830", always_xy=True)

    def to_world(lon: float, lat: float) -> tuple[float, float]:
        e, n = tr.transform(lon, lat)
        return (round(e - E0, PRECISION_M), round(n - N0, PRECISION_M))

    return to_world


def clamp_world(p) -> tuple[float, float]:
    return (
        min(WORLD_SIZE, max(0.0, round(float(p[0]), PRECISION_M))),
        min(WORLD_SIZE, max(0.0, round(float(p[1]), PRECISION_M))),
    )


def polyline_length(pts) -> float:
    return sum(math.hypot(b[0] - a[0], b[1] - a[1]) for a, b in zip(pts, pts[1:]))


def canonical_sha256(obj) -> str:
    """sha256 del JSON canonico (claves ordenadas, sin espacios)."""
    blob = json.dumps(obj, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(blob).hexdigest()


def dedupe(pts):
    out = []
    for p in pts:
        if out and out[-1] == p:
            continue
        out.append(p)
    return out


def parts_of(geom) -> list:
    if geom.is_empty:
        return []
    if geom.geom_type == "LineString":
        return [geom]
    if hasattr(geom, "geoms"):
        out = []
        for g in geom.geoms:
            out.extend(parts_of(g))
        return out
    return []


WIN = box(0.0, 0.0, WORLD_SIZE, WORLD_SIZE)


def clip_to_window(pts):
    """Recorta a la ventana.

    Devuelve (partes, largo_total, largo_fuera, desvio_max_fuera_del_borde).
    Todo punto de corte queda exactamente sobre el borde (se redondea y
    acota), salvo un error numerico que se mide y se reporta.
    """
    total = polyline_length(pts)
    if len(pts) < 2:
        return [], total, total, 0.0
    line = LineString(pts)
    if not line.intersects(WIN):
        return [], total, total, 0.0
    clipped = line.intersection(WIN)
    out = []
    deviation = 0.0
    for g in parts_of(clipped):
        raw = list(g.coords)
        for p in raw:
            deviation = max(deviation,
                            max(-float(p[0]), float(p[0]) - WORLD_SIZE,
                                -float(p[1]), float(p[1]) - WORLD_SIZE))
        pts2 = dedupe([clamp_world(p) for p in raw])
        if len(pts2) >= 2:
            out.append(pts2)
    inside = sum(polyline_length(p) for p in out)
    return out, total, max(0.0, total - inside), deviation


# --------------------------------------------------------------------------
# Clasificacion
# --------------------------------------------------------------------------
def classify(tags: dict) -> tuple[str | None, str | None]:
    """Devuelve (clase, motivo_de_exclusion).

    clase = None  -> EXCLUDE por tipo de via (proposed, construction, ...).
    motivo no nulo con clase valida -> EXCLUDE por acceso (motor_vehicle/access).
    """
    hw = tags.get("highway", "")
    base = hw[: -len("_link")] if hw.endswith("_link") else hw
    if hw in EXCLUDE_KINDS or base in EXCLUDE_KINDS:
        return None, f"highway={hw}"
    if base in TRACK_KINDS:
        cls = "TRACK"
    elif base in PATH_KINDS:
        cls = "PATH"
    elif base in ROAD_KINDS:
        cls = "ROAD"
    else:
        return None, f"highway_sin_clasificar={hw or '<sin-tag>'}"
    return cls, access_reason(tags)


def access_reason(tags: dict) -> str | None:
    """Filtros de acceso. Solo `no` y `private`: no ser agresivo de mas.

    agricultural/forestry y destination NO se descartan: en un juego de
    pistas forestales son justamente el terreno que queremos.
    """
    if tags.get("motor_vehicle") == "no":
        return "motor_vehicle=no"
    if tags.get("motorcar") == "no":
        return "motorcar=no"
    if tags.get("vehicle") == "no":
        return "vehicle=no"
    acc = tags.get("access")
    if acc in ("no", "private"):
        return f"access={acc}"
    return None


def parse_width(tags: dict) -> tuple[float | None, str]:
    for key in ("width", "est_width"):
        raw = tags.get(key)
        if not raw:
            continue
        try:
            val = float(str(raw).split(";")[0].split()[0])
        except (ValueError, IndexError):
            continue
        if 0.4 <= val <= 30.0:
            return val, f"osm_{key}"
    return None, ""


def design_width(cls: str, kind: str, tracktype: str | None) -> tuple[float, str]:
    if cls == "ROAD":
        base = kind[: -len("_link")] if kind.endswith("_link") else kind
        return ROAD_WIDTH_M.get(base, 5.5), f"diseno_road/{base}"
    if cls == "TRACK":
        if tracktype in TRACK_WIDTH_M:
            return TRACK_WIDTH_M[tracktype], f"diseno_track/{tracktype}"
        return TRACK_WIDTH_DEFAULT_M, "diseno_track/sin_tracktype"
    return PATH_WIDTH_M, "diseno_path"


def design_speed(cls: str, tracktype: str | None) -> float:
    if cls == "ROAD":
        return ROAD_SPEED_FACTOR
    if cls == "TRACK":
        return TRACK_SPEED_FACTOR.get(tracktype, TRACK_SPEED_FACTOR_DEFAULT)
    return PATH_SPEED_FACTOR


# --------------------------------------------------------------------------
# Snap y simplificacion
# --------------------------------------------------------------------------
def snap_endpoints(records: list[dict], tol: float) -> tuple[list[dict], list[dict]]:
    """Pega extremos de way que caen a <= tol de un vertice ajeno.

    Solo extremos (grado 1): cruces mal mapeados o dos tramos que se tocan a
    <1 m sin compartir node. No se tocan vertices intermedios, para no
    inventar cruces entre pistas paralelas.
    """
    if tol <= 0:
        return records, []
    index: dict[tuple[int, int], list[tuple[float, float]]] = defaultdict(list)
    for rec in records:
        for p in rec["pts"]:
            index[(int(p[0] // tol), int(p[1] // tol))].append(p)

    remap: dict[tuple[float, float], tuple[float, float]] = {}
    log: list[dict] = []
    for ri, rec in enumerate(records):
        n = len(rec["pts"])
        for end in (0, n - 1):
            if n < 2:
                continue
            p = rec["pts"][end]
            gx, gy = int(p[0] // tol), int(p[1] // tol)
            best, best_d = None, tol
            for cx in (gx - 1, gx, gx + 1):
                for cy in (gy - 1, gy, gy + 1):
                    for q in index.get((cx, cy), ()):
                        if q == p:
                            continue
                        d = math.hypot(q[0] - p[0], q[1] - p[1])
                        if 0 < d <= best_d:
                            best, best_d = q, d
            if best is not None:
                remap[p] = best
                if not any(e["record"] == ri and e["from"] == [p[0], p[1]] for e in log):
                    log.append({"record": ri, "osm_id": rec["osm_id"],
                                "from": [p[0], p[1]], "to": [best[0], best[1]],
                                "dist_m": round(best_d, 3)})
    if not remap:
        return records, []

    def resolve(p, depth=0):
        while p in remap and depth < 8:
            p = remap[p]
            depth += 1
        return p

    for rec in records:
        rec["pts"] = dedupe([resolve(p) for p in rec["pts"]])
    for entry in log:
        entry["resolved_to"] = [c for c in resolve(tuple(entry["from"]))]
    return records, log


def simplify_protected(pts, protected: set[int], tol: float):
    """Douglas-Peucker por tramos, sin tocar los indices protegidos.

    Si un vertice compartido entre dos ways desapareciera, el cruce dejaria de
    existir en el grafo y la red se partiria en silencio. Por eso se parte la
    polilinea en tramos entre vertices protegidos y se simplifica cada tramo.
    """
    if len(pts) <= 2 or tol <= 0:
        return pts
    marks = sorted(protected | {0, len(pts) - 1})
    out: list[tuple[float, float]] = []
    for i in range(len(marks) - 1):
        span = pts[marks[i]:marks[i + 1] + 1]
        if len(span) <= 2:
            seg = span
        else:
            seg = [(round(float(c[0]), PRECISION_M), round(float(c[1]), PRECISION_M))
                   for c in LineString(span).simplify(tol).coords]
        for p in seg:
            if out and out[-1] == p:
                continue
            out.append(p)
    return dedupe(out)


# --------------------------------------------------------------------------
# Banda renderizada vs huellas (perfil asimetrico por estacion)
# --------------------------------------------------------------------------
def outer_half_width(road: dict) -> float:
    """Semiancho exterior de la banda renderizada (calzada + faldon)."""
    skirt = SKIRT_WIDTH_M if (road["class"] == "ROAD" and not road["bridge"]) else 0.0
    return road["width"] / 2.0 + skirt


def band_from_clearance(outer: float, raw_distance: float) -> float:
    """Semiancho exterior objetivo dado el hueco real hasta la fachada.

    Se busca `raw_distance - CLEARANCE_MARGIN_M`, pero el minimo visual tiene
    preferencia si la fachada deja algo de espacio. En huecos mas estrechos se
    acorta hasta la distancia REAL disponible: el margen es preferido, no una
    garantia. La pasada exacta de triangulos impide que la banda cruce huellas.
    """
    safe = min(outer, raw_distance)
    preferred = min(safe, max(0.0, raw_distance - CLEARANCE_MARGIN_M))
    floored = min(safe, CLEARANCE_VISUAL_MIN_HALF_M)
    return max(preferred, floored)


def arc_samples(
    points: list, step: float
) -> list[tuple[float, float, float, float, float]]:
    """Muestrea la polilinea cada <= step m.

    Devuelve [(x, z, t, nx, nz)] con t = distancia acumulada desde el inicio y
    (nx, nz) la normal unitaria izquierda en t (promedio de vecinos, igual que
    el renderer). Incluye inicio y fin.
    """
    cum = [0.0]
    for a, b in zip(points, points[1:]):
        cum.append(cum[-1] + math.hypot(b[0] - a[0], b[1] - a[1]))
    length = cum[-1]
    if length <= 0 or len(points) < 2:
        return []
    n = int(math.floor(length / step + 1e-9))
    ts = [i * step for i in range(n + 1)]
    if ts[-1] < length - 1e-9:
        ts.append(length)
    seg = 0
    raw: list[tuple[float, float, float]] = []
    for t in ts:
        while seg < len(cum) - 2 and cum[seg + 1] < t:
            seg += 1
        a, b = points[seg], points[seg + 1]
        seg_len = cum[seg + 1] - cum[seg]
        f = 0.0 if seg_len <= 0 else min(1.0, max(0.0, (t - cum[seg]) / seg_len))
        raw.append((a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, t))
    out = []
    for i, (x, z, t) in enumerate(raw):
        prev = raw[max(0, i - 1)]
        nxt = raw[min(len(raw) - 1, i + 1)]
        dx, dz = nxt[0] - prev[0], nxt[1] - prev[1]
        dist = math.hypot(dx, dz)
        if dist < 1e-9:
            nx, nz = 0.0, 0.0
        else:
            nx, nz = -dz / dist, dx / dist
        out.append((x, z, t, nx, nz))
    return out


def render_stations(points: list, max_step: float) -> list[tuple[float, float, float]]:
    """Reproduce EXACTAMENTE `resamplePolyline` de src/road-draping.ts.

    Subdivide cada tramo OSM en `ceil(len/max_step)` pasos IGUALES (no una grilla
    uniforme desde el inicio) y conserva los vertices originales. El perfil de
    recorte y su validacion deben usar esta misma lista o la comprobacion no
    corresponde a lo que dibuja el renderer.
    """
    out: list[tuple[float, float, float]] = []
    total = 0.0

    def push(x: float, z: float, t: float) -> None:
        if out and abs(out[-1][0] - x) < 1e-6 and abs(out[-1][1] - z) < 1e-6:
            return
        out.append((x, z, t))

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


def with_normals(
    stations: list[tuple[float, float, float]],
) -> list[tuple[float, float, float, float, float]]:
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


def render_half_widths(road: dict, arrays: dict | None, stations: list) -> list:
    """(hl, hr) por estacion: perfil publicado o ancho de diseno constante."""
    outer = outer_half_width(road)
    widths = []
    for _x, _z, t, _nx, _nz in stations:
        if arrays is not None:
            hl, hr = profile_at(arrays, t)
        else:
            hl = hr = outer
        widths.append((hl, hr))
    return widths


def min_filter(values: list[float], radius: int) -> list[float]:
    """Minimo movil (conservador) para cubrir el hueco entre muestras."""
    if radius <= 0:
        return list(values)
    out = []
    for i in range(len(values)):
        lo, hi = max(0, i - radius), min(len(values), i + radius + 1)
        out.append(min(values[lo:hi]))
    return out


def profile_at(arrays: dict, t: float) -> tuple[float, float]:
    """Interpola (bandLeft, bandRight) por distancia acumulada."""
    step = arrays["stepM"]
    left, right = arrays["bandLeft"], arrays["bandRight"]
    last = len(left) - 1
    pos = max(0.0, t) / step
    i0 = int(math.floor(pos))
    if i0 >= last:
        return left[last], right[last]
    f = pos - i0
    return (
        left[i0] * (1 - f) + left[i0 + 1] * f,
        right[i0] * (1 - f) + right[i0 + 1] * f,
    )


def clearance_profile(road: dict, tree, polys: list) -> dict | None:
    """Recorta el semiancho exterior por lado contra las huellas.

    Para cada estacion se mide la distancia al borde mas cercano de la huella y
    se busca dejar CLEARANCE_MARGIN_M, si el minimo visual lo permite. El margen
    es preferente, no garantizado. Un minimo movil suaviza el perfil y
    `refine_profile` comprueba los triangulos EXACTOS del renderer (mismo
    resample, paso CLEARANCE_RENDER_STEP_M) y solo puede REDUCIR. Devuelve None
    si la via no necesita recorte.
    """
    outer = outer_half_width(road)
    if outer <= 0 or tree is None:
        return None
    samples = arc_samples(road["points"], CLEARANCE_PROFILE_STEP_M)
    if len(samples) < 2:
        return None
    dist_left = [math.inf] * len(samples)
    dist_right = [math.inf] * len(samples)
    for i, (x, z, _t, nx, nz) in enumerate(samples):
        start = Point(x, z)
        for j in tree.query(start.buffer(outer)):
            boundary = polys[int(j)].exterior
            nearest = boundary.interpolate(boundary.project(start))
            vx, vy = nearest.x - x, nearest.y - z
            side = vx * nx + vy * nz
            d = math.hypot(vx, vy)
            if side >= 0:
                dist_left[i] = min(dist_left[i], d)
            else:
                dist_right[i] = min(dist_right[i], d)
    left = [
        outer if not math.isfinite(d) else band_from_clearance(outer, d)
        for d in dist_left
    ]
    right = [
        outer if not math.isfinite(d) else band_from_clearance(outer, d)
        for d in dist_right
    ]
    left = min_filter(left, CLEARANCE_MIN_FILTER_RADIUS)
    right = min_filter(right, CLEARANCE_MIN_FILTER_RADIUS)
    safe_left, safe_right = list(left), list(right)
    left, right = refine_profile(road, left, right, tree, polys)
    if not (
        any(v < outer - 1e-6 for v in left) or any(v < outer - 1e-6 for v in right)
    ):
        return None
    skirt = SKIRT_WIDTH_M if (road["class"] == "ROAD" and not road["bridge"]) else 0.0
    return {
        "stepM": CLEARANCE_PROFILE_STEP_M,
        "renderStepM": CLEARANCE_RENDER_STEP_M,
        "skirtM": round(skirt, 2),
        "outer": outer,
        "left": left,
        "right": right,
        "samples": samples,
        "arrays": {
            "stepM": CLEARANCE_PROFILE_STEP_M,
            "bandLeft": left,
            "bandRight": right,
        },
        "hidden": hidden_stretches(road, left, right, safe_left, safe_right, samples),
    }


def band_triangles(road: dict, use_profile: bool) -> list:
    """Triangulos de la banda exterior, como los dibuja el renderer.

    Usa el resample REAL (`render_stations`) con el mismo paso que el renderer
    (perfil: `renderStepM`; diseno: `RENDER_SUBDIVISION_M`). Cada tramo se emite
    como dos triangulos (igual que la malla); modelarlo asi evita cuadrilateros
    autointersecados (invalidos para GEOS) y mide la geometria real.
    """
    arrays = road.get("clearance") if use_profile else None
    step = arrays["renderStepM"] if arrays is not None else RENDER_SUBDIVISION_M
    stations = with_normals(render_stations(road["points"], step))
    if len(stations) < 2:
        return []
    widths = render_half_widths(road, arrays, stations)
    triangles = []
    for i in range(len(stations) - 1):
        hl0, hr0 = widths[i]
        hl1, hr1 = widths[i + 1]
        ring = quad_ring(stations, i, hl0, hr0, hl1, hr1)
        if ring is None:
            continue
        for a, b, c in ((0, 1, 2), (0, 2, 3)):
            tri = Polygon([ring[a], ring[b], ring[c]])
            if tri.is_valid and tri.area > 1e-12:
                triangles.append((tri, [stations[i][0], stations[i][1]]))
    return triangles


def quad_ring(samples: list, i: int, hl0: float, hr0: float, hl1: float, hr1: float):
    """Anillo de la banda entre dos estaciones (o None si degenera)."""
    x0, z0, _t0, nx0, nz0 = samples[i]
    x1, z1, _t1, nx1, nz1 = samples[i + 1]
    ring = [
        (x0 + nx0 * hl0, z0 + nz0 * hl0),
        (x0 - nx0 * hr0, z0 - nz0 * hr0),
        (x1 - nx1 * hr1, z1 - nz1 * hr1),
        (x1 + nx1 * hl1, z1 + nz1 * hl1),
    ]
    if len(set(ring)) < 4:
        return None
    return ring


def refine_profile(road: dict, left: list, right: list, tree, polys: list):
    """Reduce el perfil hasta que la banda no toque las huellas.

    La cota perpendicular no ve esquinas oblicuas ni el resample segmento a
    segmento del renderer. Esta pasada reproduce ese resample y comprueba los
    triangulos EXACTOS; cuando uno invade, encoge los indices del perfil que la
    interpolacion usa en ese tramo (los de `floor(t/step)` y `+1`), sin volver a
    aplicar el minimo movil global, que re-expandiria. Converge porque el
    semiancho solo decrece y una banda degenerada deja de producir triangulos.
    """
    step = CLEARANCE_PROFILE_STEP_M
    stations = with_normals(render_stations(road["points"], CLEARANCE_RENDER_STEP_M))
    if len(stations) < 2:
        return left, right
    arrays = {"stepM": step, "bandLeft": left, "bandRight": right}
    last = len(left) - 1
    for _ in range(4000):
        offenders: dict[tuple[int, bool], None] = {}
        for i in range(len(stations) - 1):
            hl0, hr0 = profile_at(arrays, stations[i][2])
            hl1, hr1 = profile_at(arrays, stations[i + 1][2])
            ring = quad_ring(stations, i, hl0, hr0, hl1, hr1)
            if ring is None:
                continue
            for a, b, c in ((0, 1, 2), (0, 2, 3)):
                tri = Polygon([ring[a], ring[b], ring[c]])
                if not tri.is_valid or tri.area <= 1e-12:
                    continue
                for j in tree.query(tri):
                    inter = tri.intersection(polys[int(j)])
                    if inter.is_empty or inter.area <= 1e-9:
                        continue
                    x, z, _t, nx, nz = stations[i]
                    on_left = (inter.centroid.x - x) * nx + (
                        inter.centroid.y - z
                    ) * nz >= 0
                    offenders[(i, on_left)] = None
        if not offenders:
            break
        changed = False
        for i, on_left in offenders:
            k0 = max(0, int(math.floor(stations[i][2] / step)))
            k1 = min(last, int(math.floor(stations[i + 1][2] / step)) + 1)
            target = left if on_left else right
            for k in range(k0, k1 + 1):
                value = max(0.0, target[k] - 0.10)
                if value < target[k] - 1e-12:
                    target[k] = value
                    changed = True
        if not changed:
            break
    return left, right


def hidden_stretches(
    road: dict,
    left: list,
    right: list,
    safe_left: list,
    safe_right: list,
    samples: list,
) -> list[dict]:
    """Tramos con banda CERO. No se dejan ocultos: se listan y clasifican.

    `holgura`: el eje cae dentro de la huella. `refinado`: el ray-cast inicial
    permitia banda, pero la comprobacion de los triangulos exactos del renderer
    la redujo a cero para evitar una intrusión en una esquina/curva.
    """
    out = []
    for side, arr, safe in (("left", left, safe_left), ("right", right, safe_right)):
        i = 0
        n = len(arr)
        while i < n:
            if arr[i] > 1e-9:
                i += 1
                continue
            j = i
            while j < n and arr[j] <= 1e-9:
                j += 1
            holgura = sum(1 for k in range(i, j) if safe[k] <= 1e-9)
            # `safe` is the profile after ray casting and the continuity
            # filter. If it still had width but the exact rendered triangles
            # forced this station to zero, the triangle refinement was
            # necessary; calling it an interpolation artifact was misleading.
            reason = "holgura" if holgura * 2 >= (j - i) else "refinado"
            t0 = samples[i][2]
            t1 = samples[j - 1][2]
            out.append(
                {
                    "road": road["id"],
                    "class": road["class"],
                    "side": side,
                    "t0_m": round(t0, 2),
                    "t1_m": round(t1, 2),
                    "length_m": round(t1 - t0, 2),
                    "stations": j - i,
                    "holgura_stations": holgura,
                    "refinado_stations": (j - i) - holgura,
                    "reason": reason,
                }
            )
            i = j
    return out


def overlap_report(
    roads: list[dict], tree, polys: list, ids: list, use_profile: bool
) -> dict:
    """Pares (via, edificio) cuya banda exterior pisa una huella SIN buffer.

    Antes del recorte mide el ancho de diseno; despues, el perfil publicado y
    con el mismo paso de estaciones que usara el renderer. Devuelve conteos por
    clase, totales y el subconjunto a <= CLEARANCE_NEAR_SPAWN_M del arranque.
    """
    pairs: set[tuple[str, object]] = set()
    by_class: dict[str, int] = defaultdict(int)
    pairs_near = 0
    worst: list[dict] = []
    for road in roads:
        if tree is None or not len(
            tree.query(LineString([tuple(p) for p in road["points"]]))
        ):
            continue
        for poly, origin in band_triangles(road, use_profile):
            if poly.is_empty or poly.area <= 1e-9:
                continue
            for j in tree.query(poly):
                j = int(j)
                inter = poly.intersection(polys[j])
                if inter.is_empty or inter.area <= 1e-6:
                    continue
                key = (road["id"], ids[j])
                if key in pairs:
                    continue
                pairs.add(key)
                by_class[road["class"]] += 1
                if (
                    math.hypot(origin[0] - SPAWN[0], origin[1] - SPAWN[1])
                    <= CLEARANCE_NEAR_SPAWN_M
                ):
                    pairs_near += 1
                if len(worst) < 12:
                    worst.append(
                        {
                            "road": road["id"],
                            "class": road["class"],
                            "building": ids[j],
                            "overlap_m2": round(inter.area, 3),
                            "x": round(origin[0], 2),
                            "z": round(origin[1], 2),
                        }
                    )
    return {
        "pairs": len(pairs),
        "buildings": len({b for _r, b in pairs}),
        "by_class": {c: by_class[c] for c in ("ROAD", "TRACK", "PATH") if by_class[c]},
        "pairs_within_%dm_of_spawn" % int(CLEARANCE_NEAR_SPAWN_M): pairs_near,
        "sample": worst,
    }


# --------------------------------------------------------------------------
# Grafo
# --------------------------------------------------------------------------
def build_graph(roads: list[dict]) -> dict:
    """Un nodo por vertice; arista entre vertices consecutivos de cada via.

    Asi length(arista) == largo real de la polilinea (el RoadGraph del motor
    de referencia calcula hypot(a,b), y con un vertice por tramo coincide
    exactamente con la geometria de roads.json).
    """
    node_id: dict[tuple[float, float], int] = {}
    nodes: list[list[float]] = []
    edges: list[list[int]] = []
    edge_meta: list[dict] = []
    seen_pairs: dict[frozenset, int] = {}
    dup_log: list[dict] = []

    for road in roads:
        prev = None
        for p in road["points"]:
            key = (p[0], p[1])
            nid = node_id.get(key)
            if nid is None:
                nid = len(nodes)
                node_id[key] = nid
                nodes.append([p[0], p[1]])
            if prev is not None and prev != nid:
                pair = frozenset((prev, nid))
                dup_idx = seen_pairs.get(pair)
                if dup_idx is not None:
                    # Dos ways con la MISMA geometria de tramo: el Map del
                    # RoadGraph solo conserva uno. Desempate a favor de la
                    # clase rodable, para que un tramo de asfalto mapeado
                    # sobre una senda no quede etiquetado como PATH.
                    kept_meta = edge_meta[dup_idx]
                    if PRIORITY[road["class"]] < PRIORITY[kept_meta["class"]]:
                        dup_log.append({"length_m": kept_meta["length"],
                                        "kept": road["id"], "skipped": kept_meta["roadId"],
                                        "classes": [road["class"], kept_meta["class"]],
                                        "tie_break": "reemplazada por clase rodable"})
                        edge_meta[dup_idx] = {
                            "length": kept_meta["length"],
                            "class": road["class"],
                            "roadId": road["id"],
                            "kind": road["kind"],
                            "tracktype": road.get("tracktype"),
                            "speedFactor": road["speedFactor"],
                        }
                    else:
                        dup_log.append({
                            "length_m": round(math.hypot(nodes[prev][0] - nodes[nid][0],
                                                         nodes[prev][1] - nodes[nid][1]), 3),
                            "kept": kept_meta["roadId"],
                            "skipped": road["id"],
                            "classes": [kept_meta["class"], road["class"]],
                        })
                else:
                    seen_pairs[pair] = len(edges)
                    a, b = nodes[prev], nodes[nid]
                    edges.append([prev, nid])
                    edge_meta.append({
                        "length": round(math.hypot(a[0] - b[0], a[1] - b[1]), 3),
                        "class": road["class"],
                        "roadId": road["id"],
                        "kind": road["kind"],
                        "tracktype": road.get("tracktype"),
                        "speedFactor": road["speedFactor"],
                    })
            prev = nid

    adj: list[list[tuple[int, int]]] = [[] for _ in nodes]
    for ei, (a, b) in enumerate(edges):
        adj[a].append((b, ei))
        adj[b].append((a, ei))

    return {"nodes": nodes, "edges": edges, "edge_meta": edge_meta, "adj": adj,
            "duplicate_edges": dup_log}


def component_sets(graph: dict) -> list[set[int]]:
    """Componentes conexas como conjuntos de nodos, de mayor a menor."""
    seen = [False] * len(graph["nodes"])
    out = []
    for start in range(len(graph["nodes"])):
        if seen[start]:
            continue
        stack, group = [start], set()
        seen[start] = True
        while stack:
            v = stack.pop()
            group.add(v)
            for nxt, _ in graph["adj"][v]:
                if not seen[nxt]:
                    seen[nxt] = True
                    stack.append(nxt)
        out.append(group)
    return sorted(out, key=len, reverse=True)


def on_border(p) -> bool:
    return (p[0] <= 0.01 or p[0] >= WORLD_SIZE - 0.01
            or p[1] <= 0.01 or p[1] >= WORLD_SIZE - 0.01)


def isolated_report(graph: dict, roads: list[dict], groups: list[set[int]]) -> dict:
    """Desglose de lo que NO se alcanza desde el arranque.

    Distingue dos causas muy distintas:
      * conexion_fuera_de_ventana -> la via toca el borde: el empalme real
        esta FUERA del mapa, es geometria legitima que el grafo interior no
        puede unir.
      * hueco_de_mapeo            -> no toca ningun borde: la way existe
        adentro pero no comparte node con nadie (falta el cruce en OSM).
    """
    node_comp = [0] * len(graph["nodes"])
    for ci, group in enumerate(groups):
        for v in group:
            node_comp[v] = ci

    road_lines: dict[int, list] = defaultdict(list)
    for road in roads:
        pts = [tuple(p) for p in road["points"]]
        if len(pts) >= 2:
            # todos los vertices de una way caen en la misma componente
            first = next((i for i, n in enumerate(graph["nodes"])
                          if n[0] == pts[0][0] and n[1] == pts[0][1]), None)
            if first is not None:
                road_lines[node_comp[first]].append(LineString(pts))

    main_lines = road_lines.get(0, [])
    detail = []
    km_by_cause: dict[str, Counter] = {"conexion_fuera_de_ventana": Counter(),
                                       "hueco_de_mapeo": Counter()}
    for ci, group in enumerate(groups[1:], start=1):
        km: Counter = Counter()
        road_ids = set()
        for ei, (a, b) in enumerate(graph["edges"]):
            if a in group and b in group:
                meta = graph["edge_meta"][ei]
                km[meta["class"]] += meta["length"] / 1000.0
                road_ids.add(meta["roadId"])
        lines = road_lines.get(ci, [])
        dist = min((l.distance(m) for l in lines for m in main_lines), default=None)
        border = any(on_border(p) for l in lines
                     for p in (list(l.coords)[0], list(l.coords)[-1]))
        cause = "conexion_fuera_de_ventana" if border else "hueco_de_mapeo"
        for cls, v in km.items():
            km_by_cause[cause][cls] += v
        detail.append({
            "component": ci,
            "nodes": len(group),
            "roads": sorted(road_ids),
            "km_by_class": {c: round(v, 3) for c, v in sorted(km.items())},
            "min_distance_to_main_network_m": None if dist is None else round(dist, 1),
            "touches_window_border": border,
            "cause": cause,
        })
    return {
        "components": len(groups),
        "isolated_components": len(detail),
        "track_km_unreachable_by_cause": {
            k: round(v.get("TRACK", 0.0), 3) for k, v in km_by_cause.items()},
        "detail": detail,
    }



def nearest_edge(graph: dict, p: tuple[float, float]) -> dict:
    best = {"edge": -1, "dist": math.inf, "t": 0.0, "length": 0.0}
    nodes = graph["nodes"]
    for ei, (a, b) in enumerate(graph["edges"]):
        ax, az = nodes[a]
        bx, bz = nodes[b]
        dx, dz = bx - ax, bz - az
        denom = dx * dx + dz * dz
        t = 0.0 if denom == 0 else max(0.0, min(1.0, ((p[0] - ax) * dx + (p[1] - az) * dz) / denom))
        px, pz = ax + dx * t, az + dz * t
        d = math.hypot(p[0] - px, p[1] - pz)
        if d < best["dist"]:
            best = {"edge": ei, "dist": d, "t": t, "length": math.sqrt(denom),
                    "point": [px, pz], "a": a, "b": b}
    return best


def reachable(graph: dict, seeds: list[tuple[int, float]], allowed: set[str]) -> dict:
    """Dijkstra solo para marcar alcance; suma TODA arista con ambos extremos
    alcanzados (asi los ciclos no subestiman los km)."""
    n = len(graph["nodes"])
    dist = [math.inf] * n
    heap: list[tuple[float, int]] = []
    for node, d0 in seeds:
        if d0 < dist[node]:
            dist[node] = d0
            heapq.heappush(heap, (d0, node))
    visited = [False] * n
    while heap:
        d, v = heapq.heappop(heap)
        if visited[v]:
            continue
        visited[v] = True
        for nb, ei in graph["adj"][v]:
            if graph["edge_meta"][ei]["class"] not in allowed:
                continue
            nd = d + graph["edge_meta"][ei]["length"]
            if nd < dist[nb]:
                dist[nb] = nd
                heapq.heappush(heap, (nd, nb))

    km_by_class: dict[str, float] = defaultdict(float)
    edges_reached = 0
    for ei, (a, b) in enumerate(graph["edges"]):
        meta = graph["edge_meta"][ei]
        if meta["class"] not in allowed:
            continue
        if visited[a] and visited[b]:
            km_by_class[meta["class"]] += meta["length"] / 1000.0
            edges_reached += 1
    max_dist = max((dist[i] for i in range(n) if visited[i] and dist[i] < math.inf), default=0.0)
    return {
        "nodes_reached": int(sum(visited)),
        "edges_reached": edges_reached,
        "km_by_class": {k: round(v, 3) for k, v in sorted(km_by_class.items())},
        "max_route_distance_m": round(max_dist, 1),
    }


# --------------------------------------------------------------------------
# Principal
# --------------------------------------------------------------------------
def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--raw", default=str(RAW_MAIN), help="JSON crudo de Overpass")
    ap.add_argument("--no-audit", action="store_true", help="omite la auditoria de buffer")
    args = ap.parse_args()

    raw_path = Path(args.raw)
    manifest = json.loads(RAW_MANIFEST.read_text(encoding="utf-8")) if RAW_MANIFEST.exists() else {}
    payload = json.loads(raw_path.read_text(encoding="utf-8"))
    buildings_doc = json.loads(BUILDINGS_PATH.read_text(encoding="utf-8"))
    building_footprints = [
        (building["id"], Polygon(building["footprint"]))
        for building in buildings_doc["buildings"]
    ]
    # Huellas CRUDAS para recortar y validar. CLEARANCE_MARGIN_M es una
    # preferencia de ancho: band_from_clearance la aplica donde cabe junto al
    # minimo visual; el despeje de triángulos contra la huella sí es obligatorio.
    clearance_ids = [bid for bid, _poly in building_footprints]
    raw_polys = [poly for _bid, poly in building_footprints]
    raw_tree = STRtree(raw_polys) if raw_polys else None
    elements = payload.get("elements", [])
    to_world = make_projector()

    # -------- 1-3. proyeccion, recorte y clasificacion ---------------------
    records: list[dict] = []
    ways_outside = 0
    km_outside = 0.0
    max_deviation = 0.0
    clip_errors: list[dict] = []
    border_endpoints = 0
    interior_endpoints = 0
    border_ways: set[int] = set()
    crossing_ways: set[int] = set()
    inside_ways: set[int] = set()

    for el in elements:
        if el.get("type") != "way" or "geometry" not in el:
            continue
        tags = el.get("tags", {})
        proj = [to_world(p["lon"], p["lat"]) for p in el["geometry"]]
        if len(proj) < 2:
            continue
        orig_keys = set(proj)
        parts, total, lost, dev = clip_to_window(proj)
        max_deviation = max(max_deviation, dev)
        if not parts:
            ways_outside += 1
            km_outside += total
            continue
        if lost > 0.001:
            crossing_ways.add(el["id"])
        else:
            inside_ways.add(el["id"])
        km_outside += lost

        cls, reason = classify(tags)
        # Los polígonos peatonales se sirven como áreas, no como líneas. En
        # particular OSM marca La Plaza como un anillo `highway=pedestrian` +
        # `place=square`; dibujar ese contorno como pista crea una cinta que
        # atraviesa varias huellas de edificios. El renderer de vías no consume
        # superficies, así que las excluimos de la red lineal.
        closed = len(proj) >= 4 and proj[0] == proj[-1]
        is_pedestrian_area = closed and (
            tags.get("area") == "yes"
            or "area:highway" in tags
            or (tags.get("highway") in PATH_KINDS and tags.get("place") == "square")
        )
        if is_pedestrian_area:
            cls, reason = None, "area_feature"
        for pts in parts:
            for end in (pts[0], pts[-1]):
                on_border = (end[0] <= 0.01 or end[0] >= WORLD_SIZE - 0.01
                             or end[1] <= 0.01 or end[1] >= WORLD_SIZE - 0.01)
                if on_border:
                    border_endpoints += 1
                else:
                    interior_endpoints += 1
                    if end not in orig_keys:
                        # ni sobre el borde ni un vertice original de la way:
                        # eso SI seria un recorte erroneo.
                        clip_errors.append({"way": el["id"], "point": list(end),
                                            "highway": tags.get("highway")})
            if lost > 0.001:
                border_ways.add(el["id"])
            records.append({
                "osm_id": el["id"],
                "pts": pts,
                "tags": tags,
                "class": cls,
                "exclude_reason": reason,
            })

    # -------- 4. snap (solo ways con clase valida) -------------------------
    class_ok = [r for r in records if r["class"] is not None]
    class_ok, snap_log = snap_endpoints(class_ok, SNAP_TOL_M)

    # -------- 4b. simplificacion protegida (solo las que van al juego) -----
    kept = [r for r in class_ok if r["exclude_reason"] is None]
    km_before_simplify = sum(polyline_length(r["pts"]) for r in kept)
    vertices_before = sum(len(r["pts"]) for r in kept)
    building_guard_reverted: list[int] = []
    vertex_count: Counter = Counter()
    for rec in kept:
        for p in rec["pts"]:
            vertex_count[p] += 1
    for rec in kept:
        prot = {i for i, p in enumerate(rec["pts"]) if vertex_count[p] >= 2}
        source_pts = rec["pts"]
        simplified_pts = simplify_protected(source_pts, prot, SIMPLIFY_TOL_M)
        simplified_line = LineString(simplified_pts)
        source_line = LineString(source_pts)
        created_building_crossing = any(
            simplified_line.relate_pattern(footprint, "T********")
            and not source_line.relate_pattern(footprint, "T********")
            for _, footprint in building_footprints
        )
        if created_building_crossing:
            # Mantiene los vertices OSM de esa way cuando el atajo Douglas-Peucker
            # entra en una huella. Asi el trazado sigue la calle real junto a las
            # fachadas en vez de dibujar una recta a traves de los edificios.
            building_guard_reverted.append(rec["osm_id"])
            rec["pts"] = source_pts
        else:
            rec["pts"] = simplified_pts
    km_after_simplify = sum(polyline_length(r["pts"]) for r in kept)
    vertices_after = sum(len(r["pts"]) for r in kept)

    # -------- objeto via ---------------------------------------------------
    def make_road(rec: dict, idx: int, n_parts: int) -> dict:
        tags = rec["tags"]
        cls = rec["class"]
        tracktype = tags.get("tracktype")
        width_osm, width_src = parse_width(tags)
        if width_osm is not None:
            width, width_source = width_osm, width_src
        else:
            width, width_source = design_width(cls, tags.get("highway", ""), tracktype)
        road_id = str(rec["osm_id"]) if n_parts == 1 else f"{rec['osm_id']}.{idx}"
        return {
            "id": road_id,
            "osmType": "way",
            "osmId": rec["osm_id"],
            "name": tags.get("name", ""),
            "ref": tags.get("ref", ""),
            "kind": tags.get("highway", ""),        # compat Road.kind
            "class": cls,                           # ROAD | TRACK | PATH
            "width": round(width, 2),
            "widthSource": width_source,            # osm_* | diseno_*
            "speedFactor": design_speed(cls, tracktype),
            "oneway": tags.get("oneway") == "yes",
            "onewayValue": tags.get("oneway", ""),
            "grade": tags.get("layer", "0"),        # compat Road.grade = layer
            "tracktype": tracktype or "",
            "surface": tags.get("surface", ""),
            "smoothness": tags.get("smoothness", ""),
            "access": tags.get("access", ""),
            "bridge": tags.get("bridge", "no") not in ("no", ""),
            "tunnel": tags.get("tunnel", "no") not in ("no", ""),
            "length": round(polyline_length(rec["pts"]), 2),
            "points": [[p[0], p[1]] for p in rec["pts"]],
            "tags": tags,                           # tags crudos, completos
        }

    parts_by_way: dict[int, list[dict]] = defaultdict(list)
    for rec in kept:
        parts_by_way[rec["osm_id"]].append(rec)
    roads: list[dict] = []
    for recs in parts_by_way.values():
        for i, rec in enumerate(recs):
            roads.append(make_road(rec, i, len(recs)))

    # -------- banda renderizada vs huellas (H-000008) ----------------------
    # ANTES: ancho de diseno (width/2 + faldon) contra huellas SIN buffer.
    # RECORTE: hueco REAL hasta la fachada (sin buffer) + holgura preferente +
    #          refinado contra los triangulos EXACTOS del renderer (resample real).
    # DESPUES: perfil publicado con el mismo resample del renderer.
    # No se toca "points": la geometria de navegacion y el eje central quedan
    # intactos; solo cambia el semiancho dibujado por estacion.
    before_report = overlap_report(
        roads, raw_tree, raw_polys, clearance_ids, use_profile=False
    )

    clamped_roads = 0
    clamped_by_class: Counter = Counter()
    degraded_stations = 0  # pavement < minimo visual pero > 0
    degraded_sample: list[dict] = []
    hidden_runs: list[dict] = []
    hidden_stations = 0
    hidden_holgura_stations = 0
    hidden_refined_stations = 0
    hidden_roads: set[str] = set()
    fully_zero_roads: list[str] = []
    min_pavement_half = float("inf")

    def published(v: float) -> float:
        """Redondeo HACIA ABAJO a mm: publicar nunca re-expande la banda."""
        return math.floor(v * 1000.0 + 1e-9) / 1000.0

    for road in roads:
        prof = clearance_profile(road, raw_tree, raw_polys)
        if prof is None:
            continue
        outer = prof["outer"]
        half = road["width"] / 2.0
        skirt = prof["skirtM"]
        clamped_roads += 1
        clamped_by_class[road["class"]] += 1
        for side, arr in (("left", prof["left"]), ("right", prof["right"])):
            for i, v in enumerate(arr):
                if v >= outer - 1e-6:
                    continue
                pavement_half = max(0.0, min(half, v - skirt))
                min_pavement_half = min(min_pavement_half, pavement_half)
                sx, sz, st = (
                    prof["samples"][i][0],
                    prof["samples"][i][1],
                    prof["samples"][i][2],
                )
                if v > 1e-9 and pavement_half < CLEARANCE_VISUAL_MIN_HALF_M:
                    degraded_stations += 1
                    if len(degraded_sample) < 12:
                        degraded_sample.append(
                            {
                                "road": road["id"],
                                "class": road["class"],
                                "side": side,
                                "t_m": round(st, 2),
                                "band_half_m": round(v, 2),
                                "pavement_half_m": round(pavement_half, 2),
                                "visual_min_half_m": CLEARANCE_VISUAL_MIN_HALF_M,
                                "x": round(sx, 2),
                                "z": round(sz, 2),
                            }
                        )
        for run in prof["hidden"]:
            hidden_runs.append(run)
            hidden_stations += run["stations"]
            hidden_holgura_stations += run["holgura_stations"]
            hidden_refined_stations += run["refinado_stations"]
            hidden_roads.add(road["id"])
        if all(
            v <= 1e-9
            for _side, arr in (("left", prof["left"]), ("right", prof["right"]))
            for v in arr
        ):
            fully_zero_roads.append(road["id"])
        road["clearance"] = {
            "stepM": prof["stepM"],
            "renderStepM": CLEARANCE_RENDER_STEP_M,
            "skirtM": round(skirt, 2),
            "bandLeft": [published(v) for v in prof["left"]],
            "bandRight": [published(v) for v in prof["right"]],
        }

    after_report = overlap_report(
        roads, raw_tree, raw_polys, clearance_ids, use_profile=True
    )
    clearance_stats = {
        "model": (
            "semiancho exterior asimetrico por estacion; ray-cast contra huellas "
            "sin buffer; clearance_margin_m preferido si el minimo visual cabe; "
            "minimo movil de "
            "+-min_filter_radius_m; refinado contra los triangulos EXACTOS del "
            "renderer (resample real) y redondeo conservador hacia abajo; la "
            "banda incluye el faldon de ROAD"
        ),
        "profile_step_m": CLEARANCE_PROFILE_STEP_M,
        "min_filter_radius_m": CLEARANCE_MIN_FILTER_RADIUS * CLEARANCE_PROFILE_STEP_M,
        "clearance_margin_m": CLEARANCE_MARGIN_M,
        "skirt_width_m": SKIRT_WIDTH_M,
        "render_subdivision_m": RENDER_SUBDIVISION_M,
        "render_step_clamped_m": CLEARANCE_RENDER_STEP_M,
        "visual_min_pavement_half_m": CLEARANCE_VISUAL_MIN_HALF_M,
        "published_precision_m": 0.001,
        "before": before_report,
        "after": after_report,
        "clamped_roads": clamped_roads,
        "clamped_roads_by_class": {
            c: clamped_by_class[c]
            for c in ("ROAD", "TRACK", "PATH")
            if clamped_by_class[c]
        },
        "degraded_stations_below_visual_min": degraded_stations,
        "degraded_sample": degraded_sample,
        "min_pavement_half_m": round(
            0.0 if min_pavement_half == float("inf") else min_pavement_half, 3
        ),
        "hidden_stations": hidden_stations,
        "hidden_holgura_stations": hidden_holgura_stations,
        "hidden_refinado_stations": hidden_refined_stations,
        "hidden_roads": sorted(hidden_roads),
        "roads_fully_zero_band": sorted(fully_zero_roads),
        "hidden_runs": hidden_runs,
        "note": (
            "bandLeft/bandRight son el semiancho EXTERIOR total (calzada+faldon) publicado "
            "por via recortada; el renderer deriva calzada y faldon, subdivide al "
            "render_step_clamped_m publicado y no recupera ancho entre estaciones. "
            "`after` mide el perfil publicado con el resample REAL del renderer contra "
            "huellas SIN buffer: 0 invasiones. Las estaciones con banda CERO no se "
            "ocultan: quedan en hidden_runs, clasificadas como `holgura` (eje dentro del "
            "margen) o `refinado` (la comprobacion exacta de triangulos redujo la banda a cero)."
        ),
    }

    # grafo diagnostico: ademas de las del juego, las excluidas SOLO por acceso
    diag_by_way: dict[int, list[dict]] = defaultdict(list)
    for rec in class_ok:
        diag_by_way[rec["osm_id"]].append(rec)
    diag_roads: list[dict] = []
    for recs in diag_by_way.values():
        for i, rec in enumerate(recs):
            diag_roads.append(make_road(rec, i, len(recs)))

    # -------- 5. grafos ----------------------------------------------------
    graph = build_graph(roads)
    graph_diag = build_graph(diag_roads)
    groups = component_sets(graph)
    comp_sizes = [len(g) for g in groups]
    unreachable = isolated_report(graph, roads, groups)

    # -------- 6. conectividad desde Villafranca ----------------------------
    ne = nearest_edge(graph, SPAWN)
    if ne["edge"] >= 0:
        seeds = [(ne["a"], ne["t"] * ne["length"]), (ne["b"], (1 - ne["t"]) * ne["length"])]
        spawn_meta = graph["edge_meta"][ne["edge"]]
        spawn_dist = round(ne["dist"], 2)
    else:
        seeds, spawn_meta, spawn_dist = [], {}, None

    total_km: Counter = Counter()
    for road in roads:
        total_km[road["class"]] += road["length"] / 1000.0

    def variant(graph_, seeds_, allowed) -> dict:
        res = reachable(graph_, seeds_, allowed)
        track_total = total_km["TRACK"]
        track_reached = res["km_by_class"].get("TRACK", 0.0)
        res.update({
            "track_total_km": round(track_total, 3),
            "track_reached_km": round(track_reached, 3),
            "track_pct_reached": round(100.0 * track_reached / track_total, 1) if track_total else 0.0,
            "allowed_classes": sorted(allowed),
        })
        return res

    conn_all = variant(graph, seeds, {"ROAD", "TRACK", "PATH"})
    conn_drive = variant(graph, seeds, {"ROAD", "TRACK"})
    conn_diag = variant(graph_diag, seeds, {"ROAD", "TRACK", "PATH"})

    # -------- cobertura: rejilla 1 km y cuadrante noreste ------------------
    grid = [[{"x": i * 1000, "z": j * 1000, "ROAD": 0.0, "TRACK": 0.0, "PATH": 0.0}
             for i in range(6)] for j in range(6)]
    quadrant_km: Counter = Counter()
    lines = [(road, LineString([tuple(p) for p in road["points"]])) for road in roads]
    for j in range(6):
        for i in range(6):
            cell = box(i * 1000, j * 1000, (i + 1) * 1000, (j + 1) * 1000)
            for road, line in lines:
                if line.intersects(cell):
                    km = line.intersection(cell).length / 1000.0
                    grid[j][i][road["class"]] += km
                    if i >= 3 and j >= 3:
                        quadrant_km[road["class"]] += km
    for j in range(6):
        for i in range(6):
            for cls in ("ROAD", "TRACK", "PATH"):
                grid[j][i][cls] = round(grid[j][i][cls], 3)

    # -------- bbox viejo: km de la ventana que no cubria -------------------
    tr4326 = Transformer.from_crs("EPSG:4326", "EPSG:25830", always_xy=True)
    s, w, n, e = OLD_BBOX_WGS84
    corners_ll = [(s, w), (s, e), (n, e), (n, w)]
    ring = []
    for i in range(4):
        a, b = corners_ll[i], corners_ll[(i + 1) % 4]
        for k in range(25):
            f = k / 25.0
            ee, nn = tr4326.transform(a[1] + (b[1] - a[1]) * f, a[0] + (b[0] - a[0]) * f)
            ring.append((ee - E0, nn - N0))
    old_poly = Polygon(ring)
    old_gap_km: Counter = Counter()
    old_gap_ways: set[int] = set()
    for road, line in lines:
        outside = line.difference(old_poly).length / 1000.0
        if outside > 0.001:
            old_gap_km[road["class"]] += outside
            old_gap_ways.add(road["osmId"])

    # -------- auditoria de cobertura (buffer 0.01 deg) ---------------------
    audit = None
    if RAW_AUDIT.exists() and not args.no_audit:
        audit_payload = json.loads(RAW_AUDIT.read_text(encoding="utf-8"))
        audit_els = {el["id"]: el for el in audit_payload.get("elements", [])}
        main_ids = {el["id"] for el in elements}
        only_audit = sorted(set(audit_els) - main_ids)
        missing = []
        for mid in only_audit:
            el = audit_els[mid]
            pts = [to_world(p["lon"], p["lat"]) for p in el.get("geometry", [])]
            if len(pts) < 2:
                continue
            ln = LineString(pts).intersection(WIN)
            if ln.length > 0:
                missing.append({"way": mid,
                                "highway": el.get("tags", {}).get("highway"),
                                "km": round(ln.length / 1000, 3)})
        audit = {
            "file": str(RAW_AUDIT.relative_to(ROOT)),
            "buffer_deg": 0.01,
            "ways": len(audit_els),
            "ways_only_in_audit": len(only_audit),
            "ways_only_in_main": len(sorted(main_ids - set(audit_els))),
            "ways_intersecting_window_missing_in_main": missing,
            "coverage_ok": len(missing) == 0,
            "criterion": ("toda way que intersecta la ventana con longitud > 0 "
                          "debe estar en la descarga principal"),
        }

    # -------- agregados ----------------------------------------------------
    km_by_class = {c: round(total_km[c], 3) for c in ("ROAD", "TRACK", "PATH")}
    km_by_kind: Counter = Counter()
    segs_by_kind: Counter = Counter()
    ways_by_kind: dict[int, str] = {}
    for road in roads:
        km_by_kind[road["kind"]] += road["length"] / 1000.0
        segs_by_kind[road["kind"]] += 1
        ways_by_kind[road["osmId"]] = road["kind"]
    km_by_tracktype: Counter = Counter()
    segs_by_tracktype: Counter = Counter()
    for road in roads:
        if road["class"] == "TRACK":
            key = road["tracktype"] or "sin_tracktype"
            km_by_tracktype[key] += road["length"] / 1000.0
            segs_by_tracktype[key] += 1
    km_by_surface: Counter = Counter()
    for road in roads:
        if road["surface"]:
            km_by_surface[road["surface"]] += road["length"] / 1000.0

    excl: dict[str, dict] = {}
    for rec in records:
        if rec["class"] is not None and rec["exclude_reason"] is None:
            continue
        reason = rec["exclude_reason"] or "sin-clase"
        d = excl.setdefault(reason, {"ways": set(), "km": 0.0, "km_by_class": Counter()})
        d["ways"].add(rec["osm_id"])
        part_km = polyline_length(rec["pts"]) / 1000.0
        d["km"] += part_km
        d["km_by_class"][rec["class"] or "sin_clase"] += part_km
    excl_out = {
        k: {"ways": len(v["ways"]), "km": round(v["km"], 3),
            "km_by_class": {c: round(km, 3) for c, km in sorted(v["km_by_class"].items())}}
        for k, v in sorted(excl.items())
    }

    tiny = [r["id"] for r in roads if r["length"] < TINY_SEG_M]

    # -------- stats.json ---------------------------------------------------
    stats = {
        "meta": {
            "generated_at_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "script": "scripts/roads/build_roads.py",
            "coordinate_system": "EPSG:25830 (UTM 30N) -> worldX = E - 471500, worldZ = N - 4689000",
            "world_scale": 1.0,
            "window_m": {"e": [E_MIN, E_MAX], "n": [N_MIN, N_MAX], "size": [WORLD_SIZE, WORLD_SIZE]},
            "spawn_world": list(SPAWN),
            "license": "ODbL-1.0 — OpenStreetMap contributors",
            "caveats": [
                "Tags OSM = metadatos mapeados, no mediciones.",
                "width y speedFactor son estimaciones de DISENO de gameplay.",
                "grade = tag layer (compatibilidad con Road del motor de referencia); "
                "la calidad de la pista esta en tracktype.",
            ],
        },
        "source": {
            "file": str(raw_path.relative_to(ROOT)),
            "bytes": raw_path.stat().st_size,
            "sha256": hashlib.sha256(raw_path.read_bytes()).hexdigest(),
            "endpoint": manifest.get("endpoint"),
            "user_agent": manifest.get("user_agent"),
            "query": manifest.get("query"),
            "bbox_wgs84_s_w_n_e": manifest.get("bbox_wgs84_s_w_n_e"),
            "buffer_deg": manifest.get("buffer_deg"),
            "overpass_timestamp_osm_base": manifest.get("overpass_timestamp_osm_base"),
            "fetched_at_utc": manifest.get("fetched_at_utc"),
            "elements": manifest.get("elements"),
        },
        "counts": {
            "ways_downloaded": len(elements),
            "ways_kept": len({r["osmId"] for r in roads}),
            "segments_kept": len(roads),
            "segments_shorter_than_2m": len(tiny),
            "ways_excluded": len({r["osm_id"] for r in records
                                  if r["class"] is None or r["exclude_reason"] is not None}),
            "ways_fully_outside_window": ways_outside,
            "by_class_segments": {c: sum(1 for r in roads if r["class"] == c)
                                  for c in ("ROAD", "TRACK", "PATH")},
            "by_kind_segments": dict(sorted(segs_by_kind.items())),
            "by_kind_ways": dict(sorted(Counter(ways_by_kind.values()).items())),
        },
        "length_km": {
            "by_class": km_by_class,
            "total": round(sum(km_by_class.values()), 3),
            "by_kind": {k: round(v, 3) for k, v in sorted(km_by_kind.items(), key=lambda kv: -kv[1])},
            "by_tracktype": {k: round(v, 3) for k, v in sorted(km_by_tracktype.items())},
            "by_surface": {k: round(v, 3) for k, v in sorted(km_by_surface.items(), key=lambda kv: -kv[1])},
        },
        "segments_by_tracktype": dict(sorted(segs_by_tracktype.items())),
        "excluded": {
            "by_reason": excl_out,
            "total_km": round(sum(v["km"] for v in excl.values()), 3),
            "total_ways": len({r["osm_id"] for r in records
                               if r["class"] is None or r["exclude_reason"] is not None}),
            "note": "access=agricultural/forestry NO se descartan (terreno forestal jugable).",
        },
        "design_tables": {
            "note": "DISENO de gameplay, NO medicion. OSM no trae ancho fiable salvo el tag width.",
            "width_m": {
                "by_road_kind": ROAD_WIDTH_M,
                "by_tracktype": TRACK_WIDTH_M,
                "tracktype_default": TRACK_WIDTH_DEFAULT_M,
                "path": PATH_WIDTH_M,
                "precedence": "tag width/est_width de OSM > tabla de diseno",
            },
            "speed_factor": {
                "road": ROAD_SPEED_FACTOR,
                "by_tracktype": TRACK_SPEED_FACTOR,
                "tracktype_default": TRACK_SPEED_FACTOR_DEFAULT,
                "path": PATH_SPEED_FACTOR,
                "meaning": "multiplicador sobre la velocidad maxima en asfalto; lo aplica el runtime",
            },
        },
        "simplification": {
            "tolerance_m": SIMPLIFY_TOL_M,
            "protected_vertices": "vertices compartidos entre ways (cruces) nunca se eliminan",
            "building_guard_reverted_ways": sorted(set(building_guard_reverted)),
            "building_guard_note": "si simplificar una way crea un cruce con una huella, se conserva su geometria original",
            "vertices_before": vertices_before,
            "vertices_after": vertices_after,
            "vertices_removed_pct": round(100.0 * (vertices_before - vertices_after) / max(1, vertices_before), 1),
            "km_before": round(km_before_simplify / 1000.0, 3),
            "km_after": round(km_after_simplify / 1000.0, 3),
            "km_shaved_by_simplify": round((km_before_simplify - km_after_simplify) / 1000.0, 3),
            "note": ("las cifras de length_km de este archivo se miden SOBRE la geometria "
                     "simplificada; la simplificacion recorta la curvatura y acorta un "
                     "0.03% aprox."),
        },
        "graph": {
            "nodes": len(graph["nodes"]),
            "edges": len(graph["edges"]),
            "duplicate_edges_same_pair": {
                "count": len(graph["duplicate_edges"]),
                "detail": graph["duplicate_edges"],
                "note": ("dos ways con el mismo tramo de geometria; el Map del "
                         "RoadGraph solo conserva uno, aqui se registra cual"),
            },
            "components": len(comp_sizes),
            "largest_component_nodes": comp_sizes[0] if comp_sizes else 0,
            "largest_component_pct_nodes": round(
                100.0 * (comp_sizes[0] if comp_sizes else 0) / max(1, len(graph["nodes"])), 1),
            "components_le_2_nodes": sum(1 for s in comp_sizes if s <= 2),
            "format": "{nodes:[[x,z]...], edges:[[a,b]...], edgeMeta:[{length,class,roadId,kind,tracktype,speedFactor}]}",
            "compatible_with": "rama `noded` de RoadGraph (src/navigation.ts del motor de referencia)",
            "quantization": (
                "Sin cuantizar /3: el motor de referencia cuantiza porque deriva los nodos "
                "de listas de puntos; aca los nodos vienen explicitos y en coordenadas OSM "
                "exactas (cm), la cuantizacion solo introduciria error. La estructura "
                "{nodes, edges en pares} es la misma y entra tal cual al constructor."
            ),
        },
        "connectivity": {
            "spawn_world": list(SPAWN),
            "spawn_nearest_edge": {
                "distance_m": spawn_dist,
                "class": spawn_meta.get("class"),
                "roadId": spawn_meta.get("roadId"),
                "road_name": next((r["name"] for r in roads if r["id"] == spawn_meta.get("roadId")), ""),
                "note": "el arranque se proyecta al arista mas cercana y se siembran ambos extremos",
            },
            "variants": {
                "todas_las_clases": conn_all,
                "solo_rodables_ROAD_TRACK": conn_drive,
                "diagnostico_incluyendo_access_excluido": conn_diag,
            },
            "unreachable": unreachable,
        },
        "coverage": {
            "audit_buffer": audit,
            "query_bbox_complete": None if audit is None else audit["coverage_ok"],
            "ways_touching_window_border": len(border_ways),
            "ways_crossing_border": len(crossing_ways),
            "ways_fully_inside_window": len(inside_ways),
            "border_endpoints": border_endpoints,
            "interior_endpoints": interior_endpoints,
            "interior_endpoints_not_original_vertex": len(clip_errors),
            "clip_errors": clip_errors[:20],
            "max_vertex_outside_window_m": round(max_deviation, 9),
            "km_outside_window": round(km_outside, 3),
            "ways_fully_outside_window": ways_outside,
            "snap": {
                "tolerance_m": SNAP_TOL_M,
                "applied": len(snap_log),
                "max_distance_m": max((s["dist_m"] for s in snap_log), default=0.0),
                "detail": snap_log[:40],
            },
            "quadrant_km_northeast_x>=3000_z>=3000": {
                c: round(quadrant_km[c], 3) for c in ("ROAD", "TRACK", "PATH")},
            "grid_1km_km": grid,
            "old_bbox_gap": {
                "old_bbox_wgs84_s_w_n_e": list(OLD_BBOX_WGS84),
                "km_outside_old_bbox_by_class": {k: round(v, 3) for k, v in sorted(old_gap_km.items())},
                "ways_affected": len(old_gap_ways),
                "note": "km de la ventana que el bbox viejo NO cubria",
            },
        },
        "footprint_clearance": clearance_stats,
        "hashes": {
            "roads_sha256": canonical_sha256(roads),
            "navigation_nodes_sha256": canonical_sha256(graph["nodes"]),
            "navigation_edges_sha256": canonical_sha256(graph["edges"]),
            "note": "sha256 del JSON canonico; reproducible entre corridas (no depende de generated_at_utc)",
        },
    }

    # -------- escritura ----------------------------------------------------
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    roads_doc = {
        "meta": {
            **stats["meta"],
            "source_sha256": stats["source"]["sha256"],
            "overpass_timestamp_osm_base": stats["source"]["overpass_timestamp_osm_base"],
            "length_km": km_by_class,
            "grade_semantics": (
                "'grade' conserva el significado del motor de referencia (tag layer: '0' = "
                "rasante, '1' = puente/viado). La calidad de la pista esta en 'tracktype'."
            ),
            "points_precision_m": 10 ** -PRECISION_M,
            "schema": {
                "id": "string unico por segmento; 'id.N' si el recorte partio la way",
                "class": "ROAD | TRACK | PATH",
                "kind": "highway crudo de OSM (compat Road.kind)",
                "width": "metros; widthSource indica si es tag OSM o estimacion de diseno",
                "speedFactor": "multiplicador de velocidad (diseno de gameplay)",
                "points": "[[worldX, worldZ], ...] metros, origen sudoeste",
                "tags": "tags OSM crudos completos",
                "clearance": (
                    "opcional; presente solo si la banda renderizada se recorto cerca de una "
                    "huella. {stepM, renderStepM, skirtM, bandLeft[], bandRight[]} = semiancho "
                    "EXTERIOR total (calzada+faldon) por estacion, en metros, lado izquierdo y "
                    "derecho. El renderer interpola por distancia, subdivide a renderStepM y "
                    "deriva calzada y faldon. Ausente = ancho de diseno constante (width/2)."
                ),
            },
        },
        "roads": roads,
    }
    nav_doc = {
        "meta": {
            "generated_at_utc": stats["meta"]["generated_at_utc"],
            "coordinate_system": stats["meta"]["coordinate_system"],
            "window_m": stats["meta"]["window_m"],
            "source_sha256": stats["source"]["sha256"],
            "nodes_semantics": "un nodo por vertex de via; [worldX, worldZ] en metros",
            "edges_semantics": "[i, j] indices sobre nodes; grafo NO dirigido",
            "edgeMeta_semantics": "arreglo paralelo: edgeMeta[k] describe a edges[k]",
            "distance_semantics": (
                "edgeMeta[k].length (metros) coincide con hypot(nodes[i], nodes[j]) porque "
                "hay un nodo por vertice; el RoadGraph del motor de referencia calcula "
                "exactamente lo mismo."
            ),
            "road_graph_compatible": True,
            "dijkstra_hint": (
                "el peso es length/speedFactor si se quiere ruteo rapido; "
                "sin speedFactor el grafo rutea por distancia"
            ),
        },
        "nodes": graph["nodes"],
        "edges": graph["edges"],
        "edgeMeta": graph["edge_meta"],
    }

    (OUT_DIR / "roads.json").write_text(
        json.dumps(roads_doc, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    (OUT_DIR / "navigation.json").write_text(
        json.dumps(nav_doc, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    (OUT_DIR / "stats.json").write_text(
        json.dumps(stats, ensure_ascii=False, indent=2), encoding="utf-8")

    # -------- consola ------------------------------------------------------
    print(f"ways bajados       : {len(elements)}")
    print(f"ways conservados   : {stats['counts']['ways_kept']}  segmentos: {len(roads)}")
    print(f"km por clase       : {km_by_class}  total {stats['length_km']['total']} km")
    print(f"km por tracktype   : {stats['length_km']['by_tracktype']}")
    print(f"excluidos          : {stats['excluded']['total_km']} km -> {list(excl_out)}")
    print(f"grafo              : {graph_stats_line(graph, comp_sizes)}")
    print(f"borde              : {len(border_ways)} ways / {border_endpoints} endpoints en borde / "
          f"{interior_endpoints} interiores / {len(clip_errors)} erroneos")
    print(f"desvio max fuera   : {max_deviation} m")
    print(f"NE (km)            : {dict(quadrant_km)}")
    print(f"desde Villafranca  : TODAS {conn_all['track_reached_km']} km TRACK "
          f"({conn_all['track_pct_reached']}%) | SOLO RODABLES {conn_drive['track_reached_km']} km "
          f"({conn_drive['track_pct_reached']}%)")
    print(f"TRACK inalcanzable : {unreachable['track_km_unreachable_by_cause']}")
    print(
        f"huellas banda      : antes {before_report['pairs']} pares / {before_report['buildings']} "
        f"edificios -> despues {after_report['pairs']} / {after_report['buildings']} "
        f"(recortadas {clamped_roads} vias; banda cero {hidden_stations} estaciones en "
        f"{len(hidden_roads)} vias [holgura {hidden_holgura_stations}, "
        f"refinado {hidden_refined_stations}]; min calzada "
        f"{clearance_stats['min_pavement_half_m']} m; vias ancho 0 "
        f"{len(fully_zero_roads)})"
    )
    if audit is not None:
        print(f"auditoria buffer   : coverage_ok={audit['coverage_ok']} "
              f"(solo_en_audit={audit['ways_only_in_audit']}, "
              f"faltantes_que_intersectan={len(audit['ways_intersecting_window_missing_in_main'])})")
    for name in ("roads.json", "navigation.json", "stats.json"):
        p = OUT_DIR / name
        print(f"-> {p.relative_to(ROOT)}  {p.stat().st_size} bytes")


def graph_stats_line(graph: dict, comp_sizes: list[int]) -> str:
    return (f"{len(graph['nodes'])} nodos / {len(graph['edges'])} aristas / "
            f"{len(comp_sizes)} componentes / mayor={comp_sizes[0] if comp_sizes else 0}")


if __name__ == "__main__":
    main()
