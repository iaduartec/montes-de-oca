#!/usr/bin/env python3
"""Constructor de la capa de agua: láminas, cota del vaso y grilla de profundidad.

Entrada : data/water/raw/osm_water_window.json (+ manifiesto con sha256)
          public/terrain/tiles/tile_*.json (DEM, alturas ABSOLUTAS en metros)
Salida  : public/water/water.json (láminas trianguladas + cota + grilla)
          public/water/stats.json (conteos y medidas para el reporte)

Sin dependencias: solo stdlib. La Tarea 3 rellenó `ribbons` (cintas de
río/arroyo) y verificó `dam` en este mismo archivo; el esquema incluye ambas.

Uso:
  python3 scripts/water/build_water.py           # escribe water.json + stats.json
  python3 scripts/water/build_water.py --check   # NO escribe: re-deriva y
                                                 # compara byte a byte con lo
                                                 # commiteado, diciendo por qué
                                                 # difiere si no coincide.
"""

from __future__ import annotations

import hashlib
import json
import math
import sys
import unicodedata
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CONFIG = ROOT / "public" / "terrain" / "config.json"
RAW_FILE = ROOT / "data" / "water" / "raw" / "osm_water_window.json"
MANIFEST_FILE = ROOT / "data" / "water" / "raw" / "osm_water_window_manifest.json"
RING_FILE = ROOT / "data" / "water" / "raw" / "osm_reservoir_alba_ring.json"
RING_MANIFEST_FILE = (
    ROOT / "data" / "water" / "raw" / "osm_reservoir_alba_ring_manifest.json"
)
TILES_DIR = ROOT / "public" / "terrain" / "tiles"
OUT_DIR = ROOT / "public" / "water"
WATER_FILE = OUT_DIR / "water.json"
STATS_FILE = OUT_DIR / "stats.json"

WINDOW_M = 6000.0  # ventana jugable: [0, 6000] x [0, 6000] m de mundo
DATUM_M = 870.0  # datum vertical del juego (mundo y = absoluta - 870)
CELL_M = 25.0  # paso de la grilla de profundidad y del muestreo interior
RING_STEP_M = 10.0  # remuestreo del anillo para distancias a la orilla
MAX_DEPTH_M = 18.0  # profundidad máxima junto a la presa (decímetros: 180)
DEEP_FRAC = 0.45  # la profundidad satura a esta fracción de la distancia máxima
NEAR_BASE = 0.35  # peso base del factor presa (lejos del muro hay 35 % del fondo)
NEAR_DAM = 0.65  # peso del factor presa (junto al muro llega al 100 %)
FALLBACK_LEVEL_M = 1013.0  # plano del vaso según la especificación (AGUA.md §2)
SHORE_ZERO_M = CELL_M * 0.5  # banda de orilla con profundidad 0 forzada
FOAM_M = 1.5  # espuma blanca en el borde de cada lámina
DAM_WIDTH_M = 6.0  # ancho del muro de la presa
WIDTH_BY_KIND = {"river": 7.0, "stream": 2.5, "ditch": 1.2}  # ancho de cinta (m)
CALADO_M = {"river": 0.25, "stream": 0.18, "ditch": 0.12}  # calado de la cinta (m)
RIBBON_STEP_M = 2.5  # remuestreo del eje de cintas, como las pistas
FORD_MARGIN_M = 1.0  # margen sobre el semiancho para detectar cruces de ruta
ROUTE_FILE = ROOT / "src" / "gameplay" / "first-route.ts"  # polilínea real


# --- Anillo del embalse (Embalse de Alba, relation OSM 18149353) ---
#
# El crudo de la Tarea 1 (`out geom tags` sobre la ventana) trae la relation
# del embalse SIN miembros ni geometría (solo bounds), así que el anillo se
# versiona como crudo propio: `data/water/raw/osm_reservoir_alba_ring.json`
# (22 ways ensamblados por extremos, orden canónico) + su manifiesto con
# sha256. Sin ese archivo el build FALLA: no hay fallback silencioso.
def canonicalize_ring(ring: list) -> list[tuple[float, float]]:
    """Orden canónico: sin repetición del cierre, rotado al mínimo (x, z).

    Misma regla que `fetch_water.py` (allí sobre lon/lat; la proyección es
    lineal con factores positivos, así que el mínimo es el mismo punto).
    """
    pts = [(float(p[0]), float(p[1])) for p in ring]
    if len(pts) > 1 and pts[0] == pts[-1]:
        pts.pop()
    if len(pts) < 3:
        raise ValueError(f"anillo del embalse degenerado: {len(pts)} vértices")
    i = min(range(len(pts)), key=lambda k: (pts[k][0], pts[k][1]))
    return pts[i:] + pts[:i]


def load_reservoir_ring(proj: dict, origin: dict) -> list[tuple[float, float]]:
    """Anillo del embalse en metros de mundo, desde el crudo versionado."""
    if not RING_FILE.exists():
        raise FileNotFoundError(
            f"falta {RING_FILE}: regenerá el crudo con "
            "`python3 scripts/water/fetch_water.py --ring-only`"
        )
    manifest = json.loads(RING_MANIFEST_FILE.read_text())
    digest = hashlib.sha256(RING_FILE.read_bytes()).hexdigest()
    if digest != manifest.get("sha256"):
        raise ValueError(
            f"el anillo cambió: sha {digest} != manifiesto {manifest.get('sha256')}"
        )
    raw = json.loads(RING_FILE.read_text())
    world = [to_world(lon, lat, proj, origin) for lon, lat in raw["ring"]]
    return canonicalize_ring(world)


# ---------------------------------------------------------------- proyección
def load_projection() -> tuple[dict, dict]:
    """Lee origen y proyección del config del terreno (esquina SW del mundo)."""
    cfg = json.loads(CONFIG.read_text())
    return cfg["projection"], cfg["origin"]


def to_world(lon: float, lat: float, proj: dict, origin: dict) -> tuple[float, float]:
    """Pasa lon/lat a metros de mundo (x = E - 471500, z = N - 4689000)."""
    return (
        (lon - origin["lon"]) * proj["metersPerDegreeLon"],
        (lat - origin["lat"]) * proj["metersPerDegreeLat"],
    )


# ------------------------------------------------------------------ DEM
def load_tiles() -> tuple[list[dict], dict[tuple[int, int], list[dict]]]:
    """Carga los 36 tiles e indexa por celda de 1000 m para height_at O(1).

    Cada celda apunta a los tiles cuyo bbox (con 1 m de borde) la toca, así
    los puntos de borde resuelven sin búsqueda lineal.
    """
    tiles = []
    for path in sorted(TILES_DIR.glob("tile_*.json")):
        tiles.append(json.loads(path.read_text())["grid"])
    index: dict[tuple[int, int], list[dict]] = {}
    for g in tiles:
        x1 = g["x0"] + (g["columns"] - 1) * g["dx"]
        z1 = g["z0"] + (g["rows"] - 1) * g["dz"]
        for ix in range(
            math.floor((g["x0"] - 1.0) / 1000), math.floor((x1 + 1.0) / 1000) + 1
        ):
            for iz in range(
                math.floor((g["z0"] - 1.0) / 1000), math.floor((z1 + 1.0) / 1000) + 1
            ):
                index.setdefault((ix, iz), []).append(g)
    return tiles, index


def height_at(index: dict[tuple[int, int], list[dict]], x: float, z: float) -> float:
    """Altura ABSOLUTA del DEM (metros) en un punto de mundo."""
    cands = index.get((math.floor(x / 1000), math.floor(z / 1000)), [])
    for g in cands:
        if (
            g["x0"] - 0.01 <= x <= g["x0"] + (g["columns"] - 1) * g["dx"] + 0.01
            and g["z0"] - 0.01 <= z <= g["z0"] + (g["rows"] - 1) * g["dz"] + 0.01
        ):
            c = round((x - g["x0"]) / g["dx"])
            r = round((z - g["z0"]) / g["dz"])
            return g["heights"][r * g["columns"] + c]
    raise KeyError((x, z))


# ------------------------------------------------------------- geometría 2D
def point_in_polygon(x: float, z: float, ring: list) -> bool:
    """Ray casting; el borde cuenta como dentro (orilla mojada)."""
    inside = False
    n = len(ring)
    for i in range(n):
        x1, z1 = ring[i]
        x2, z2 = ring[(i + 1) % n]
        # punto sobre el segmento -> dentro
        if point_segment_distance(x, z, x1, z1, x2, z2) < 1e-9:
            return True
        if (z1 > z) != (z2 > z):
            xinters = x1 + (z - z1) * (x2 - x1) / (z2 - z1)
            if xinters > x:
                inside = not inside
    return inside


def point_segment_distance(
    px: float, pz: float, ax: float, az: float, bx: float, bz: float
) -> float:
    """Distancia de un punto al segmento AB."""
    dx, dz = bx - ax, bz - az
    if dx == 0.0 and dz == 0.0:
        return math.hypot(px - ax, pz - az)
    t = ((px - ax) * dx + (pz - az) * dz) / (dx * dx + dz * dz)
    t = max(0.0, min(1.0, t))
    return math.hypot(px - (ax + t * dx), pz - (az + t * dz))


def resample(ring: list, step: float) -> list[tuple[float, float]]:
    """Remuestrea el anillo con un punto aprox. cada `step` metros."""
    pts: list[tuple[float, float]] = []
    n = len(ring)
    for i in range(n):
        x1, z1 = ring[i]
        x2, z2 = ring[(i + 1) % n]
        seg = math.hypot(x2 - x1, z2 - z1)
        k = max(1, int(seg / step))
        for j in range(k):
            t = j / k
            pts.append((x1 + (x2 - x1) * t, z1 + (z2 - z1) * t))
    return pts


def resample_line(pts: list, step: float) -> list[tuple[float, float]]:
    """Remuestrea una LÍNEA ABIERTA con un punto aprox. cada `step` metros.

    A diferencia de `resample` (anillos cerrados), conserva los extremos y no
    añade el segmento de cierre: un río no vuelve a su nacimiento.
    """
    out: list[tuple[float, float]] = []
    for i in range(len(pts) - 1):
        x1, z1 = pts[i]
        x2, z2 = pts[i + 1]
        seg = math.hypot(x2 - x1, z2 - z1)
        k = max(1, int(round(seg / step)))
        for j in range(k):
            t = j / k
            out.append((x1 + (x2 - x1) * t, z1 + (z2 - z1) * t))
    out.append((pts[-1][0], pts[-1][1]))
    return out


def min_distance_to_ring(x: float, z: float, ring: list, step: float = 10.0) -> float:
    """Distancia a la orilla con muestreo del anillo (cota superior, error<step)."""
    return min(math.hypot(x - px, z - pz) for (px, pz) in resample(ring, step))


def sample_ring_interior(ring: list, step: float = 25.0) -> list[tuple[float, float]]:
    """Puntos de una malla `step` dentro del polígono (para la moda de cota)."""
    xs = [p[0] for p in ring]
    zs = [p[1] for p in ring]
    pts = []
    z = min(zs)
    while z <= max(zs):
        x = min(xs)
        while x <= max(xs):
            if point_in_polygon(x, z, ring):
                pts.append((x, z))
            x += step
        z += step
    return pts


def polygon_area(ring: list) -> float:
    """Área del polígono (shoelace, valor absoluto)."""
    return (
        abs(
            sum(
                ring[i][0] * ring[(i + 1) % len(ring)][1]
                - ring[(i + 1) % len(ring)][0] * ring[i][1]
                for i in range(len(ring))
            )
        )
        / 2.0
    )


def clip_ring_to_window(ring: list) -> list:
    """Recorte Sutherland–Hodgman contra el rectángulo [0, 6000]² del terreno."""
    edges = [
        (0, 0.0, 1, 0.0),  # x >= 0
        (1, WINDOW_M, -1, 0.0),  # x <= 6000
        (2, 0.0, 0, 1.0),  # z >= 0
        (3, WINDOW_M, 0, -1.0),  # z <= 6000
    ]

    def inside(p: tuple[float, float], edge: tuple) -> bool:
        _, bound, sx, sz = edge
        v = p[0] if sx else p[1]
        s = sx if sx else sz
        return (v - bound) * s >= -1e-9

    def cross(a: tuple[float, float], b: tuple[float, float], edge: tuple):
        _, bound, sx, _ = edge
        if sx:
            t = (bound - a[0]) / (b[0] - a[0]) if b[0] != a[0] else 0.0
        else:
            t = (bound - a[1]) / (b[1] - a[1]) if b[1] != a[1] else 0.0
        t = max(0.0, min(1.0, t))
        return (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)

    poly = [(float(p[0]), float(p[1])) for p in ring]
    for edge in edges:
        if not poly:
            return []
        out = []
        prev = poly[-1]
        pin = inside(prev, edge)
        for cur in poly:
            cin = inside(cur, edge)
            if cin:
                if not pin:
                    out.append(cross(prev, cur, edge))
                out.append(cur)
            elif pin:
                out.append(cross(prev, cur, edge))
            prev, pin = cur, cin
        poly = out
    # quita duplicados consecutivos y el cierre repetido
    clean: list = []
    for p in poly:
        if not clean or math.hypot(p[0] - clean[-1][0], p[1] - clean[-1][1]) > 1e-9:
            clean.append(p)
    if (
        len(clean) > 1
        and math.hypot(clean[0][0] - clean[-1][0], clean[0][1] - clean[-1][1]) < 1e-9
    ):
        clean.pop()
    return clean


def clip_segment_to_window(
    ax: float, az: float, bx: float, bz: float
) -> tuple[tuple[float, float], tuple[float, float]] | None:
    """Recorte Liang–Barsky de un segmento contra [0, 6000]²; None si no entra."""
    t0, t1 = 0.0, 1.0
    dx, dz = bx - ax, bz - az
    for p, q in (
        (-dx, ax),
        (dx, WINDOW_M - ax),
        (-dz, az),
        (dz, WINDOW_M - az),
    ):
        if abs(p) < 1e-12:
            if q < 0:
                return None  # paralelo y fuera
            continue
        r = q / p
        if p < 0:
            if r > t1:
                return None
            t0 = max(t0, r)
        else:
            if r < t0:
                return None
            t1 = min(t1, r)
    if t0 > t1:
        return None
    return (
        (ax + dx * t0, az + dz * t0),
        (ax + dx * t1, az + dz * t1),
    )


def clip_line_to_window(pts: list) -> list[list[tuple[float, float]]]:
    """Recorta una línea abierta a la ventana; devuelve tramos (runs) disjuntos.

    Un way que sale y vuelve a entrar produce varios tramos; cada tramo con
    <2 puntos lo descarta quien llama (nunca se silencia).
    """
    runs: list[list[tuple[float, float]]] = []
    cur: list[tuple[float, float]] = []
    for i in range(len(pts) - 1):
        seg = clip_segment_to_window(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1])
        if seg is None:
            if cur:
                runs.append(cur)
                cur = []
            continue
        (cx0, cz0), (cx1, cz1) = seg
        if not cur:
            cur = [(cx0, cz0)]
        elif math.hypot(cx0 - cur[-1][0], cz0 - cur[-1][1]) > 1e-6:
            # el segmento anterior salió de la ventana: empieza otro tramo
            runs.append(cur)
            cur = [(cx0, cz0)]
        cur.append((cx1, cz1))
    if cur:
        runs.append(cur)
    return runs


def _signed_area2(ring: list) -> float:
    return sum(
        ring[i][0] * ring[(i + 1) % len(ring)][1]
        - ring[(i + 1) % len(ring)][0] * ring[i][1]
        for i in range(len(ring))
    )


def _point_in_triangle(px: float, pz: float, a: tuple, b: tuple, c: tuple) -> bool:
    def sign(x1, z1, x2, z2, x3, z3):
        return (x1 - x3) * (z2 - z3) - (x2 - x3) * (z1 - z3)

    d1 = sign(px, pz, a[0], a[1], b[0], b[1])
    d2 = sign(px, pz, b[0], b[1], c[0], c[1])
    d3 = sign(px, pz, c[0], c[1], a[0], a[1])
    neg = (d1 < -1e-9) or (d2 < -1e-9) or (d3 < -1e-9)
    pos = (d1 > 1e-9) or (d2 > 1e-9) or (d3 > 1e-9)
    return not (neg and pos)


def ear_clip(ring: list) -> list[int]:
    """Triangulación por recorte de orejas; devuelve índices planos sobre `ring`.

    El abanico simple solo vale para polígonos convexos; el vaso es cóncavo,
    así que se recortan orejas (vértice convexo cuyo triángulo no contiene a
    ningún otro vértice). Los índices referencian `ring` tal cual llega.
    """
    n = len(ring)
    if n < 3:
        return []
    pts = [(float(p[0]), float(p[1])) for p in ring]
    order = list(range(n))
    if _signed_area2(pts) < 0:
        order.reverse()  # trabaja en CCW sin tocar los índices originales
    # elimina vértices colineales consecutivos (orejas degeneradas)
    kept = []
    m = len(order)
    for k in range(m):
        a = pts[order[(k - 1) % m]]
        b = pts[order[k]]
        c = pts[order[(k + 1) % m]]
        if abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) > 1e-9:
            kept.append(order[k])
    order = kept
    if len(order) < 3:
        return []

    def convex(a: tuple, b: tuple, c: tuple) -> bool:
        return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]) > 1e-9

    tris: list[int] = []
    guard = 0
    while len(order) > 3 and guard < n * n * 4:
        guard += 1
        ear = -1
        for k in range(len(order)):
            a = pts[order[(k - 1) % len(order)]]
            b = pts[order[k]]
            c = pts[order[(k + 1) % len(order)]]
            if not convex(a, b, c):
                continue
            if any(
                order[j]
                not in (
                    order[(k - 1) % len(order)],
                    order[k],
                    order[(k + 1) % len(order)],
                )
                and _point_in_triangle(pts[order[j]][0], pts[order[j]][1], a, b, c)
                for j in range(len(order))
            ):
                continue
            ear = k
            break
        if ear == -1:  # polígono con auto-intersección: no recorta más
            break
        tris += [
            order[(ear - 1) % len(order)],
            order[ear],
            order[(ear + 1) % len(order)],
        ]
        order.pop(ear)
    if len(order) == 3:
        tris += order
    return tris


def sheet_triangles_area(ring: list, indices: list[int]) -> float:
    """Suma de áreas de los triángulos (para el invariante del validador)."""
    total = 0.0
    for t in range(0, len(indices) - 2, 3):
        a, b, c = ring[indices[t]], ring[indices[t + 1]], ring[indices[t + 2]]
        total += (
            abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2.0
        )
    return total


# ------------------------------------------------------------- cota y grilla
def pool_level(index: dict, ring: list, fallback: float) -> float:
    """Cota del vaso: moda del DEM dentro del polígono en bins de 1 m."""
    counts: dict[int, int] = {}
    for x, z in sample_ring_interior(ring, step=CELL_M):
        v = height_at(index, x, z)
        counts[round(v)] = counts.get(round(v), 0) + 1
    if not counts:
        return fallback
    return float(max(counts.items(), key=lambda kv: kv[1])[0])


DAM_LINE: list = []  # extremos del way waterway=dam, en mundo (lo rellena main)


def dam_distance(x: float, z: float) -> float:
    """Distancia al segmento del muro de la presa."""
    (ax, az), (bx, bz) = DAM_LINE
    return point_segment_distance(x, z, ax, az, bx, bz)


def depth_grid(index: dict, ring: list, level_m: float, cell_m: float = CELL_M) -> dict:
    """Profundidad plausible: 0 en la orilla, hasta 18 m junto a la presa."""
    xs = [p[0] for p in ring]
    zs = [p[1] for p in ring]
    x0, z0 = min(xs), min(zs)
    cols = int((max(xs) - x0) / cell_m) + 1
    rows = int((max(zs) - z0) / cell_m) + 1
    shore_dist = {  # distancia a la orilla por celda, con muestreo del anillo
        (c, r): min_distance_to_ring(
            x0 + c * cell_m, z0 + r * cell_m, ring, step=RING_STEP_M
        )
        for r in range(rows)
        for c in range(cols)
    }
    dam_dist = {
        k: dam_distance(x0 + k[0] * cell_m, z0 + k[1] * cell_m) for k in shore_dist
    }
    max_shore = max(shore_dist.values()) or 1.0
    max_dam = max(dam_dist.values()) or 1.0
    depths = []
    for r in range(rows):
        for c in range(cols):
            x, z = x0 + c * cell_m, z0 + r * cell_m
            inside = point_in_polygon(x, z, ring)
            if not inside:
                depths.append(0)
                continue
            if shore_dist[(c, r)] <= SHORE_ZERO_M:
                depths.append(0)  # orilla: el vado moja pero no hunde
                continue
            near_dam = 1.0 - min(1.0, dam_dist[(c, r)] / max_dam)
            deep = min(1.0, shore_dist[(c, r)] / (DEEP_FRAC * max_shore))
            depths.append(
                int(round(10 * MAX_DEPTH_M * deep * (NEAR_BASE + NEAR_DAM * near_dam)))
            )
    return {
        "originX": round(x0, 2),
        "originZ": round(z0, 2),
        "cellM": cell_m,
        "cols": cols,
        "rows": rows,
        "depthsDm": depths,
        "levelM": round(level_m, 2),
        "maxDepthM": (max(depths) / 10.0 if depths else 0),
    }


# ------------------------------------------------------------------ builders
def slug(name: str, fallback: str) -> str:
    """Llave estable para una lámina a partir de su nombre OSM."""
    base = unicodedata.normalize("NFKD", name or "").encode("ascii", "ignore").decode()
    base = "".join(ch.lower() if (ch.isalnum() or ch == " ") else " " for ch in base)
    base = "-".join(base.split())
    return base or fallback


def build_sheets(
    raw: dict, proj: dict, origin: dict, index: dict, pool: float, reservoir: list
) -> tuple[list[dict], list[dict], int]:
    """Láminas: embalse (anillo del crudo versionado) + laguna/charcas/pilón.

    Devuelve (sheets, descartadas, parciales). Un anillo degenerado tras el
    recorte (<3 vértices) se descarta y se cuenta, nunca se silencia; una
    triangulación parcial de ear-clip (ver abajo) se conserva pero se cuenta
    en `parciales`, nunca se acepta en silencio.
    """
    sheets: list[dict] = []
    dropped: list[dict] = []
    parciales = 0

    def add_sheet(sid: str, kind: str, name: str, ring_world: list, level: float):
        nonlocal parciales
        clipped = [[round(v, 2) for v in p] for p in clip_ring_to_window(ring_world)]
        if len(clipped) < 3:
            dropped.append(
                {
                    "id": sid,
                    "motivo": "anillo degenerado tras el recorte",
                    "vertices": len(clipped),
                }
            )
            return
        indices = ear_clip(clipped)
        if len(indices) < 3 or len(indices) % 3 != 0:
            dropped.append(
                {"id": sid, "motivo": "triangulación vacía", "vertices": len(clipped)}
            )
            return
        # ear-clip no avisa si deja un polígono con auto-intersección a
        # medias: el área de los triángulos delata la triangulación parcial
        # (el validador exige error < 0,5 % por lámina).
        poly = polygon_area(clipped)
        tris = sheet_triangles_area(clipped, indices)
        if poly > 0 and abs(tris - poly) / poly > 0.005:
            parciales += 1
        sheets.append(
            {
                "id": sid,
                "kind": kind,
                "name": name,
                "levelM": round(level, 2),
                "ring": clipped,
                "indices": indices,
                "foamM": FOAM_M,
            }
        )

    # Embalse: lámina a cota de vaso (moda del DEM + 0,15 m de resguardo).
    add_sheet(
        "embalse-alba",
        "reservoir",
        "Embalse de Alba",
        [tuple(p) for p in reservoir],
        pool + 0.15,
    )

    # Láminas menores: cota del terreno circundante + 0,15 m (AGUA.md §2).
    for el in raw.get("elements", []):
        if el.get("type") != "way":
            continue
        tags = el.get("tags", {})
        if tags.get("natural") != "water" or tags.get("water") == "wastewater":
            continue
        if tags.get("water") == "reservoir":
            continue  # el vaso ya sale del anillo de arriba
        geom = el.get("geometry", [])
        if len(geom) < 4 or geom[0] != geom[-1]:
            dropped.append(
                {
                    "id": f"water-{el.get('id')}",
                    "motivo": "way de agua no cerrado",
                    "vertices": len(geom),
                }
            )
            continue
        ring = [to_world(g["lon"], g["lat"], proj, origin) for g in geom[:-1]]
        try:
            shore = sorted(height_at(index, x, z) for (x, z) in ring)
        except KeyError:
            dropped.append(
                {
                    "id": f"water-{el.get('id')}",
                    "motivo": "fuera del DEM",
                    "vertices": len(ring),
                }
            )
            continue
        kind = tags.get("water") if tags.get("water") in ("lake", "pond") else "pond"
        # Criterio: la lámina debe quedar POR ENCIMA de todo su anillo
        # (invariante AGUA.md §6: cota ≥ terreno debajo). Se parte de la
        # mediana del terreno de los vértices + 0,15 m y, si algún vértice
        # queda por encima (p. ej. el pilón: mediana 897 con un vértice a
        # 898), se sube a máx(vértices) + 0,15 m. Las láminas menores son
        # diminutas; subir es inocuo. El embalse NO usa este camino: su cota
        # sigue siendo moda del DEM + 0,15 m.
        nivel = shore[len(shore) // 2] + 0.15
        if shore[-1] > nivel:
            nivel = shore[-1] + 0.15
        add_sheet(
            slug(tags.get("name", ""), f"water-{el.get('id')}"),
            kind,
            tags.get("name", f"water-{el.get('id')}"),
            ring,
            nivel,
        )
    return sheets, dropped, parciales


def ribbon_from_way(
    index: dict, element: dict, kind: str, proj: dict, origin: dict
) -> tuple[list[dict], list[dict]]:
    """Cintas de un way río/arroyo/zanja: un way puede dar varios tramos.

    Devuelve (cintas, descartadas). Cada cinta lleva su eje remuestreado a
    2,5 m con la cota del terreno por punto, el ancho y el calado de su tipo.
    """
    tags = element.get("tags", {})
    geom = element.get("geometry", [])
    osm_id = f"waterway-{element.get('id')}"
    if len(geom) < 2:
        return [], [{"id": osm_id, "motivo": "way con <2 nodos", "vertices": len(geom)}]
    try:
        width = float(tags.get("width") or WIDTH_BY_KIND[kind])
    except (TypeError, ValueError):
        width = WIDTH_BY_KIND[kind]
    width = max(0.8, width)
    calado = CALADO_M[kind]
    world = [to_world(g["lon"], g["lat"], proj, origin) for g in geom]
    ribbons: list[dict] = []
    dropped: list[dict] = []
    for tramo, run in enumerate(clip_line_to_window(world)):
        if len(run) < 2:
            dropped.append(
                {"id": osm_id, "motivo": "tramo con <2 puntos tras el recorte"}
            )
            continue
        eje = resample_line(run, RIBBON_STEP_M)
        try:
            pts = [
                [round(x, 2), round(z, 2), round(height_at(index, x, z), 2)]
                for x, z in eje
            ]
        except KeyError:
            dropped.append({"id": osm_id, "motivo": "fuera del DEM"})
            continue
        ribbons.append(
            {
                "kind": kind,
                "name": tags.get("name", ""),
                "widthM": round(width, 2),
                "caladoM": calado,
                "points": pts,
                "_osm": osm_id,  # trazabilidad interna (no se serializa)
                "_tramo": tramo,  # idem
            }
        )
    if not ribbons and not dropped:
        dropped.append({"id": osm_id, "motivo": "íntegramente fuera de la ventana"})
    return ribbons, dropped


def build_ribbons(
    raw: dict, proj: dict, origin: dict, index: dict
) -> tuple[list[dict], list[dict], list[dict]]:
    """Cintas de ríos/arroyos/zanjas desde los ways con geometría propia.

    Devuelve (cintas, entubadas, descartadas). No se dibujan como cinta el
    muro (`waterway=dam`, va aparte en `dam`) ni las láminas de
    `water=wastewater`; los tramos con `tunnel=*` o `culvert=*` van entubados
    (pintarlos cruzaría calzada y camino) y se cuentan, nunca se silencian.
    """
    ribbons: list[dict] = []
    entubadas: list[dict] = []
    dropped: list[dict] = []
    for el in raw.get("elements", []):
        if el.get("type") != "way":
            continue
        tags = el.get("tags", {})
        kind = tags.get("waterway")
        if kind == "dam":
            continue  # el muro va aparte (build_dam)
        if tags.get("water") == "wastewater":
            continue  # balsas de depuradora: no se dibujan
        if kind not in WIDTH_BY_KIND:
            continue  # láminas (natural=water) y resto: no son cintas
        if tags.get("tunnel") is not None or tags.get("culvert") is not None:
            entubadas.append(
                {
                    "id": f"waterway-{el.get('id')}",
                    "name": tags.get("name", ""),
                    "motivo": "entubado (tunnel/culvert)",
                }
            )
            continue
        unas, unas_fuera = ribbon_from_way(index, el, kind, proj, origin)
        ribbons.extend(unas)
        dropped.extend(unas_fuera)
    ribbons.sort(key=lambda r: (r["_osm"], r["_tramo"]))
    return ribbons, entubadas, dropped


def load_route_polyline() -> list[tuple[float, float]]:
    """Polilínea real de la ruta (first-route.ts, metros de mundo).

    Se extrae con regex acotada al bloque `polyline:` (los bloques
    `waypoints:`/`checkpoints:` también tienen pares x/z y no valen).
    """
    src = ROUTE_FILE.read_text()
    seg = src[src.index("polyline:") : src.index("waypoints:")]
    import re

    pts = [
        (float(x), float(z))
        for x, z in re.findall(r"x:\s*([\d.]+),\s*z:\s*([\d.]+)", seg)
    ]
    if len(pts) < 2:
        raise ValueError(f"polilínea de la ruta degenerada en {ROUTE_FILE}")
    return pts


def ford_depths(
    index: dict, ribbons: list[dict], route: list[tuple[float, float]]
) -> list[dict]:
    """Calado real en los cruces de la ruta: (superficie − terreno) en el punto.

    La superficie de la cinta en el punto de cruce es la cota del terreno de
    su eje interpolada + el calado del tipo; el calado medido es esa
    superficie menos el terreno bajo la ruta. Un cruce por cinta como máximo
    (el punto de la ruta más cercano a su eje, dentro del semiancho + margen).
    """
    cruces: list[dict] = []
    for r in ribbons:
        eje = [(p[0], p[1], p[2]) for p in r["points"]]
        # prefiltro por bbox del eje para no medir toda la ruta por cinta
        margen = r["widthM"] / 2.0 + FORD_MARGIN_M
        xs = [p[0] for p in eje]
        zs = [p[1] for p in eje]
        x0, x1, z0, z1 = (
            min(xs) - margen,
            max(xs) + margen,
            min(zs) - margen,
            max(zs) + margen,
        )
        mejor = None
        for rx, rz in route:
            if not (x0 <= rx <= x1 and z0 <= rz <= z1):
                continue
            # distancia al eje con proyección por segmento + cota interpolada
            for i in range(len(eje) - 1):
                ax, az, ay = eje[i]
                bx, bz, by = eje[i + 1]
                dx, dz = bx - ax, bz - az
                denom = dx * dx + dz * dz
                t = ((rx - ax) * dx + (rz - az) * dz) / denom if denom else 0.0
                t = max(0.0, min(1.0, t))
                d = math.hypot(rx - (ax + t * dx), rz - (az + t * dz))
                if mejor is None or d < mejor[0]:
                    mejor = (d, rx, rz, ay + t * (by - ay))
        if mejor is None or mejor[0] > margen:
            continue
        d, rx, rz, superficie = mejor
        superficie += r["caladoM"]
        try:
            terreno = height_at(index, rx, rz)
        except KeyError:
            continue
        cruces.append(
            {
                "x": round(rx, 2),
                "z": round(rz, 2),
                "kind": r["kind"],
                "name": r["name"],
                "caladoM": round(superficie - terreno, 2),
            }
        )
    cruces.sort(key=lambda c: (c["x"], c["z"]))
    return cruces


def build_dam(
    raw: dict, proj: dict, origin: dict, index: dict, level: float
) -> tuple[dict, list]:
    """Muro de la presa desde el way waterway=dam (completo desde la Tarea 2)."""
    dam_ways = [
        el
        for el in raw.get("elements", [])
        if el.get("type") == "way" and el.get("tags", {}).get("waterway") == "dam"
    ]
    if not dam_ways:
        raise ValueError("crudo sin way waterway=dam")
    geom = dam_ways[0].get("geometry", [])
    pts = [to_world(g["lon"], g["lat"], proj, origin) for g in geom]
    a = [round(pts[0][0], 2), round(pts[0][1], 2)]
    b = [round(pts[-1][0], 2), round(pts[-1][1], 2)]
    base = min(height_at(index, x, z) for (x, z) in pts)
    return (
        {
            "a": a,
            "b": b,
            "crestM": round(level + 0.6, 2),
            "baseM": round(base, 2),
            "widthM": DAM_WIDTH_M,
        },
        pts,
    )


def fecha_crudo(window_raw: dict) -> str:
    """Fecha del crudo OSM, DETERMINISTA: sale del propio snapshot, nunca now().

    Se toma de `osm3s.timestamp_osm_base` del crudo de la ventana; si no
    estuviera, del `timestamp_osm_base` del crudo del anillo. Si ninguno lo
    trae, el build falla en vez de inventar una fecha (eso rompería --check).
    """
    ts = (window_raw.get("osm3s") or {}).get("timestamp_osm_base")
    if ts:
        return ts
    ring_raw = json.loads(RING_FILE.read_text())
    ts = (ring_raw.get("osm3s") or {}).get("timestamp_osm_base")
    if ts:
        return ts
    raise ValueError("el crudo no trae osm3s.timestamp_osm_base")


def derive() -> tuple[dict, dict]:
    """Deriva (water.json, stats.json) como dicts listos para serializar."""
    proj, origin = load_projection()
    raw = json.loads(RAW_FILE.read_text())
    manifest = json.loads(MANIFEST_FILE.read_text())
    digest = hashlib.sha256(RAW_FILE.read_bytes()).hexdigest()
    if digest != manifest.get("sha256"):
        raise ValueError(
            f"el crudo cambió: sha {digest} != manifiesto {manifest.get('sha256')}"
        )
    _, index = load_tiles()

    reservoir_world = load_reservoir_ring(proj, origin)
    clipped_reservoir = clip_ring_to_window([tuple(p) for p in reservoir_world])
    if len(clipped_reservoir) < 3:
        raise ValueError("el anillo del embalse queda degenerado tras el recorte")
    pool = pool_level(index, clipped_reservoir, FALLBACK_LEVEL_M)
    level = round(pool + 0.15, 2)

    dam, _ = build_dam(raw, proj, origin, index, level)
    global DAM_LINE
    DAM_LINE = [(dam["a"][0], dam["a"][1]), (dam["b"][0], dam["b"][1])]

    res_ring = [[round(p[0], 2), round(p[1], 2)] for p in clipped_reservoir]
    grid = depth_grid(index, res_ring, level)

    sheets, dropped, parciales = build_sheets(
        raw, proj, origin, index, pool, reservoir_world
    )

    ribbons_full, entubadas, cintas_fuera = build_ribbons(raw, proj, origin, index)
    route = load_route_polyline()
    cruces = ford_depths(index, ribbons_full, route)
    # el esquema de water.json está congelado: las claves internas de
    # trazabilidad (_osm, _tramo) viajan en stats.json, no en water.json.
    ribbons = [
        {k: r[k] for k in ("kind", "name", "widthM", "caladoM", "points")}
        for r in ribbons_full
    ]
    por_tipo: dict[str, int] = {}
    for r in ribbons_full:
        por_tipo[r["kind"]] = por_tipo.get(r["kind"], 0) + 1

    payload = {
        "schemaVersion": 1,
        "meta": {
            "generadoPor": "scripts/water/build_water.py",
            "sourceSha256": manifest["sha256"],
            "scriptSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
            "fuente": "OSM Overpass + IGN/CNIG MDT05",
            "fechaCrudo": fecha_crudo(raw),
        },
        "levelM": level,
        "sheets": sheets,
        "ribbons": ribbons,
        "dam": dam,
        "depthGrid": grid,
    }
    stats = {
        "levelM": level,
        "poolModeM": pool,
        "sheets": [
            {
                "id": s["id"],
                "kind": s["kind"],
                "vertices": len(s["ring"]),
                "triangulos": len(s["indices"]) // 3,
                "areaM2": round(polygon_area(s["ring"]), 1),
                "areaTrisM2": round(sheet_triangles_area(s["ring"], s["indices"]), 1),
                "levelM": s["levelM"],
            }
            for s in sheets
        ],
        "descartadas": dropped,
        "laminasParciales": parciales,
        "depthGrid": {
            "cols": grid["cols"],
            "rows": grid["rows"],
            "celdas": grid["cols"] * grid["rows"],
            "maxDepthM": grid["maxDepthM"],
        },
        "dam": {
            "baseM": dam["baseM"],
            "crestM": dam["crestM"],
            "largoM": round(
                math.hypot(dam["b"][0] - dam["a"][0], dam["b"][1] - dam["a"][1]), 1
            ),
        },
        "cintas": {
            "total": len(ribbons_full),
            "porTipo": por_tipo,
            "puntosEje": sum(len(r["points"]) for r in ribbons_full),
            "detalle": [
                {
                    "osmId": r["_osm"],
                    "tramo": r["_tramo"],
                    "kind": r["kind"],
                    "name": r["name"],
                    "puntos": len(r["points"]),
                    "largoM": round(
                        sum(
                            math.hypot(
                                r["points"][i + 1][0] - r["points"][i][0],
                                r["points"][i + 1][1] - r["points"][i][1],
                            )
                            for i in range(len(r["points"]) - 1)
                        ),
                        1,
                    ),
                }
                for r in ribbons_full
            ],
        },
        # Tramos con tunnel=* o culvert=*: van entubados bajo calzada y camino;
        # pintarlos como cinta cruzaría la ruta. Se cuentan, no se silencian.
        "cintasEntubadas": {
            "total": len(entubadas),
            "nota": "ways con tunnel=* o culvert=* (van entubados)",
            "ways": entubadas,
        },
        "cintasDescartadas": cintas_fuera,
        # Calado medido (superficie − terreno) en cada cruce cinta × ruta.
        "crucesRuta": cruces,
        "sourceSha256": manifest["sha256"],
    }
    return payload, stats


def dump(payload: dict, stats: dict) -> dict[str, bytes]:
    """Serialización determinista (byte a byte) de ambos archivos."""
    return {
        "water.json": (
            json.dumps(
                payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")
            )
            + "\n"
        ).encode(),
        "stats.json": (
            json.dumps(stats, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
            + "\n"
        ).encode(),
    }


def main() -> int:
    check = "--check" in sys.argv
    payload, stats = derive()
    blobs = dump(payload, stats)
    if check:
        ok = True
        for name, blob in blobs.items():
            path = OUT_DIR / name
            if not path.exists():
                print(f"[agua] --check: falta {name} (corre sin --check primero)")
                ok = False
                continue
            disk = path.read_bytes()
            if disk == blob:
                continue
            ok = False
            print(
                f"[agua] --check: {name} difiere "
                f"(disco {len(disk)} B, re-derivado {len(blob)} B)"
            )
            off = next(
                (i for i, (a, b) in enumerate(zip(disk, blob)) if a != b),
                min(len(disk), len(blob)),
            )
            print(
                f"[agua] --check: primer byte distinto en {off} "
                f"(disco {disk[max(0, off - 40) : off + 40]!r})"
            )
            try:
                old = json.loads(disk.decode())
                new = json.loads(blob.decode())
                print(
                    f"[agua] --check: claves de primer nivel: "
                    f"disco {sorted(old.keys())} vs nuevo {sorted(new.keys())}"
                )
                for key in sorted(set(old) | set(new)):
                    if old.get(key) != new.get(key):
                        o = json.dumps(
                            old.get(key), ensure_ascii=False, sort_keys=True
                        )[:300]
                        n = json.dumps(
                            new.get(key), ensure_ascii=False, sort_keys=True
                        )[:300]
                        print(
                            f"[agua] --check: cambia `{key}`:\n"
                            f"  disco: {o}\n  nuevo: {n}"
                        )
                        break
            except ValueError:
                pass
        if ok:
            n = len(payload["sheets"])
            nr = len(payload["ribbons"])
            g = payload["depthGrid"]
            print(
                f"[agua] OK: water.json + stats.json coinciden "
                f"({n} láminas, {nr} cintas, cota {payload['levelM']}, "
                f"grilla {g['cols']}x{g['rows']}, máx {g['maxDepthM']} m)"
            )
        return 0 if ok else 1
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for name, blob in blobs.items():
        (OUT_DIR / name).write_bytes(blob)
    n = len(payload["sheets"])
    nr = len(payload["ribbons"])
    g = payload["depthGrid"]
    print(
        f"[agua] {n} láminas · {nr} cintas · cota {payload['levelM']} m · "
        f"grilla {g['cols']}x{g['rows']} · máx {g['maxDepthM']} m · "
        f"descartadas {len(stats['descartadas'])}+{len(stats['cintasDescartadas'])} · "
        f"entubadas {stats['cintasEntubadas']['total']} · "
        f"cruces de ruta {len(stats['crucesRuta'])}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
