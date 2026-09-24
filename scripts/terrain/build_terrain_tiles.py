#!/usr/bin/env python3
"""Construye los 36 tiles de heightfield del terreno real de Villafranca.

Entrada : data/terrain/raw/mdt05_villafranca_6000m_5m.tif  (IGN MDT05, 5 m, EPSG:25830)
Salidas : public/terrain/tiles/tile_<ix>_<iz>.json  (esquema verificado)
          public/terrain/config.json                 (origen real, factores, datum, tiles)
          public/terrain/budget.json                 (presupuesto medido)
          public/terrain/ATTRIBUTION.md              (CC BY 4.0 IGN)
          docs/terrain/crosscheck_dem_tiles.json     (5 puntos DEM vs tiles)

Convención (fija, del packet — NO reinterpretar):
  * Todo en metros, worldScale = 1.
  * EPSG:25830, sin reproyectar.
  * Origen del mundo = esquina SW: E0=471500, N0=4689000.
    worldX = E - E0 ; worldZ = N - N0 ; worldY = elevación - verticalDatum.
  * Tiles de 1000 m -> 36 (6x6). Muestreo 5 m -> 201x201 nodos por tile.
  * `heights` en metros ABSOLUTOS (sin restar el datum dentro del grid).
  * `x0`/`z0` = esquina SW del tile en coords de mundo.
  * Interpolación SW->NE (no se toca).

Uso:
    .venv/bin/python scripts/terrain/build_terrain_tiles.py \
        [--dem RUTA] [--sampling 5] [--tile-size 1000]
"""
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

import numpy as np
import rasterio
from pyproj import CRS, Geod, Transformer

PROJECT_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_DEM = PROJECT_ROOT / "data" / "terrain" / "raw" / "mdt05_villafranca_6000m_5m.tif"
PUBLIC_TERRAIN = PROJECT_ROOT / "public" / "terrain"
DOCS_TERRAIN = PROJECT_ROOT / "docs" / "terrain"

# --- Convención fija del mundo -------------------------------------------------
CRS_EPSG = 25830
E0 = 471500.0
N0 = 4689000.0
SIDE_M = 6000.0
VILLAGE_EPSG25830 = (474597.258, 4692945.020)  # nodo Overpass 492410655 -> UTM30N
VILLAGE_WGS84 = (-3.3086147, 42.3883784)       # lon, lat

# Parámetros de cámara para el presupuesto "en vista" (réplica de Babylon LH).
CAMERA_FOV = 0.80          # rad, fov VERTICAL (default Babylon)
CAMERA_ASPECT = 16.0 / 9.0
CAMERA_PITCH = 0.0         # mirando al horizonte
CAMERA_EYE_M = 1.7         # altura de ojo sobre el terreno


# ------------------------------------------------------------------------------
# Interpolación idéntica al heightfield del motor (split SW->NE), sobre la grilla
# de nodos del DEM. Se usa SÓLO para el chequeo cruzado independiente.
# ------------------------------------------------------------------------------
def surface_meters(h: np.ndarray, x0: float, z0: float, dx: float, dz: float, x: float, z: float) -> float:
    columns = h.shape[1]
    rows = h.shape[0]
    c = (x - x0) / dx
    r = (z - z0) / dz
    if c < 0 or r < 0 or c > columns - 1 or r > rows - 1:
        return 0.0
    i = min(int(math.floor(c)), columns - 2)
    j = min(int(math.floor(r)), rows - 2)
    u = c - i
    v = r - j
    hSW = h[j, i]
    hSE = h[j, i + 1]
    hNW = h[j + 1, i]
    hNE = h[j + 1, i + 1]
    if u >= v:
        return float(hSW * (1 - u) + hSE * (u - v) + hNE * v)
    return float(hSW * (1 - v) + hNE * u + hNW * (v - u))


# ------------------------------------------------------------------------------
# Port mínimo de Babylon (row-major, row-vector, LEFT-handed) para estimar
# cuántos triángulos quedan "en vista" por radio combinando distancia + frustum.
# ------------------------------------------------------------------------------
def mat_look_at_lh(eye, target, up=(0.0, 1.0, 0.0)) -> list[float]:
    ex, ey, ez = eye
    z = (target[0] - ex, target[1] - ey, target[2] - ez)
    zn = math.sqrt(sum(v * v for v in z)) or 1.0
    z = (z[0] / zn, z[1] / zn, z[2] / zn)
    x = (up[1] * z[2] - up[2] * z[1], up[2] * z[0] - up[0] * z[2], up[0] * z[1] - up[1] * z[0])
    xn = math.sqrt(sum(v * v for v in x)) or 1.0
    x = (x[0] / xn, x[1] / xn, x[2] / xn)
    y = (z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0])
    return [
        x[0], y[0], z[0], 0.0,
        x[1], y[1], z[1], 0.0,
        x[2], y[2], z[2], 0.0,
        -(x[0] * ex + x[1] * ey + x[2] * ez),
        -(y[0] * ex + y[1] * ey + y[2] * ez),
        -(z[0] * ex + z[1] * ey + z[2] * ez),
        1.0,
    ]


def mat_perspective_fov_lh(fov: float, aspect: float, znear: float, zfar: float) -> list[float]:
    t = 1.0 / math.tan(fov / 2.0)
    return [
        t / aspect, 0, 0, 0,
        0, t, 0, 0,
        0, 0, zfar / (zfar - znear), 1.0,
        0, 0, -znear * zfar / (zfar - znear), 0,
    ]


def mat_mul(a: list[float], b: list[float]) -> list[float]:
    out = [0.0] * 16
    for i in range(4):
        for j in range(4):
            out[i * 4 + j] = sum(a[i * 4 + k] * b[k * 4 + j] for k in range(4))
    return out


def frustum_planes(m: list[float]) -> list[tuple[float, float, float, float]]:
    raw = [
        (m[3] + m[2], m[7] + m[6], m[11] + m[10], m[15] + m[14]),  # near
        (m[3] - m[2], m[7] - m[6], m[11] - m[10], m[15] - m[14]),  # far
        (m[3] + m[0], m[7] + m[4], m[11] + m[8], m[15] + m[12]),   # left
        (m[3] - m[0], m[7] - m[4], m[11] - m[8], m[15] - m[12]),   # right
        (m[3] - m[1], m[7] - m[5], m[11] - m[9], m[15] - m[13]),   # top
        (m[3] + m[1], m[7] + m[5], m[11] + m[9], m[15] + m[13]),   # bottom
    ]
    out = []
    for nx, ny, nz, d in raw:
        n = math.sqrt(nx * nx + ny * ny + nz * nz) or 1.0
        out.append((nx / n, ny / n, nz / n, d / n))
    return out


def sphere_in_frustum(planes, center, radius) -> bool:
    for nx, ny, nz, d in planes:
        if nx * center[0] + ny * center[1] + nz * center[2] + d < -radius:
            return False
    return True


def aabb_in_frustum(planes, lo, hi) -> bool:
    """Test exacto caja(AABB) vs frustum, por 'positive vertex' de cada plano.

    Más fino que la esfera envolvente (que en un tile de 1000 m tiene radio ~707 m
    y sobreincluye). Un AABB está fuera si todos sus puntos caen del lado negativo
    de algún plano.
    """
    for nx, ny, nz, d in planes:
        px = hi[0] if nx >= 0 else lo[0]
        py = hi[1] if ny >= 0 else lo[1]
        pz = hi[2] if nz >= 0 else lo[2]
        if nx * px + ny * py + nz * pz + d < 0:
            return False
    return True


def aabb_distance(px, pz, x0, z0, size) -> float:
    dx = max(x0 - px, 0.0, px - (x0 + size))
    dz = max(z0 - pz, 0.0, pz - (z0 + size))
    return math.hypot(dx, dz)


# ------------------------------------------------------------------------------
def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dem", type=Path, default=DEFAULT_DEM)
    parser.add_argument("--sampling", type=float, default=5.0)
    parser.add_argument("--tile-size", type=float, default=1000.0)
    parser.add_argument("--out-dir", type=Path, default=PUBLIC_TERRAIN)
    args = parser.parse_args()

    sampling = float(args.sampling)
    tile_size = float(args.tile_size)
    if SIDE_M % tile_size != 0:
        raise SystemExit(f"tile-size {tile_size} no divide el lado de mundo {SIDE_M}")
    if tile_size % sampling != 0:
        raise SystemExit(f"tile-size {tile_size} no es múltiplo del muestreo {sampling}")
    tiles_per_side = int(round(SIDE_M / tile_size))
    cells_per_tile = int(round(tile_size / sampling))
    nodes_per_tile = cells_per_tile + 1

    # --- Lectura y verificación del DEM --------------------------------------
    with rasterio.open(args.dem) as ds:
        crs = ds.crs
        if crs is None or CRS.from_user_input(crs).to_epsg() != CRS_EPSG:
            raise SystemExit(f"CRS inesperado {crs!r}; se exige EPSG:{CRS_EPSG}")
        t = ds.transform
        if (abs(t.a - sampling) > 1e-9 or abs(t.e + sampling) > 1e-9 or
                abs(t.b) > 1e-9 or abs(t.d) > 1e-9):
            raise SystemExit(f"transform incompatible: {t}")
        if abs(t.c - E0) > 1e-6 or abs(t.f - (N0 + SIDE_M)) > 1e-6:
            raise SystemExit(f"origen del raster {t.c},{t.f} != {E0},{N0 + SIDE_M}")
        expected_nodes = int(round(SIDE_M / sampling)) + 1
        if (ds.width, ds.height) != (expected_nodes, expected_nodes):
            raise SystemExit(
                f"grilla {ds.width}x{ds.height}; se esperaban {expected_nodes}x{expected_nodes}. "
                "No se rellena ni se remuestrea: corregí la descarga."
            )
        arr = ds.read(1).astype(np.float64)
        nodata = ds.nodata
        if nodata is not None and np.any(arr == float(nodata)):
            raise SystemExit("el DEM contiene celdas nodata; abortado (sin relleno silencioso)")
    n_rows, n_cols = arr.shape
    dem_min = float(arr.min())
    dem_max = float(arr.max())
    vertical_datum = math.floor(dem_min / 10.0) * 10.0

    # --- Tiles ----------------------------------------------------------------
    out_dir = args.out_dir
    tiles_dir = out_dir / "tiles"
    tiles_dir.mkdir(parents=True, exist_ok=True)
    stride = int(round(sampling))
    tile_nodes = nodes_per_tile
    total_triangles = 0
    total_vertices = 0
    total_json_bytes = 0
    per_tile = []
    tile_refs = []

    for iz in range(tiles_per_side):        # iz = índice en Z (sur -> norte)
        for ix in range(tiles_per_side):    # ix = índice en X (oeste -> este)
            x0 = ix * tile_size
            z0 = iz * tile_size
            # Índices en el raster (filas crecen al sur, por eso se invierte el orden).
            col0 = int(round((E0 + x0 - E0) / sampling))
            row_bottom = int(round((N0 + SIDE_M - (N0 + z0)) / sampling))
            # heights[r*columns + c]: r=0 es el borde SUR (z0), c=0 el OESTE (x0).
            block = arr[row_bottom - cells_per_tile: row_bottom + 1, col0: col0 + tile_nodes]
            if block.shape != (tile_nodes, tile_nodes):
                raise SystemExit(f"tile {ix},{iz}: bloque {block.shape} != ({tile_nodes},{tile_nodes})")
            block = block[::-1, :]  # fila 0 = sur
            heights = block.reshape(-1)
            if not np.all(np.isfinite(heights)):
                raise SystemExit(f"tile {ix},{iz}: alturas no finitas")
            # Se conservan enteros si el DEM es entero (MDT05 int16).
            if np.all(heights == np.round(heights)):
                heights_list = [int(v) for v in heights.tolist()]
            else:
                heights_list = [round(float(v), 3) for v in heights.tolist()]

            tile = {
                "schemaVersion": 1,
                "id": f"tile_{ix}_{iz}",
                "grid": {
                    "x0": x0,
                    "z0": z0,
                    "dx": sampling,
                    "dz": sampling,
                    "columns": tile_nodes,
                    "rows": tile_nodes,
                    "heights": heights_list,
                },
            }
            if len(heights_list) != tile_nodes * tile_nodes:
                raise SystemExit(f"tile {ix},{iz}: invariante heights roto")
            path = tiles_dir / f"tile_{ix}_{iz}.json"
            payload = json.dumps(tile, separators=(",", ":"))
            path.write_text(payload, encoding="utf-8")
            size = path.stat().st_size

            triangles = cells_per_tile * cells_per_tile * 2
            vertices = tile_nodes * tile_nodes
            total_triangles += triangles
            total_vertices += vertices
            total_json_bytes += size
            per_tile.append({
                "id": tile["id"],
                "ix": ix,
                "iz": iz,
                "x0": x0,
                "z0": z0,
                "vertices": vertices,
                "triangles": triangles,
                "json_bytes": size,
                "json_kib": round(size / 1024, 1),
                "heights_span_m": [int(min(heights)), int(max(heights))],
            })
            tile_refs.append({"id": tile["id"], "url": f"/terrain/tiles/tile_{ix}_{iz}.json"})

    if stride != sampling:
        raise SystemExit("stride inconsistente")

    # --- Origen geográfico y factores reales ---------------------------------
    to_wgs84 = Transformer.from_crs(CRS.from_epsg(CRS_EPSG), CRS.from_epsg(4326), always_xy=True)
    sw_lon, sw_lat = to_wgs84.transform(E0, N0)
    cx, cz = SIDE_M / 2.0, SIDE_M / 2.0
    center_lon, center_lat = to_wgs84.transform(E0 + cx, N0 + cz)
    geod = Geod(ellps="WGS84")
    m_per_deg_lon = geod.inv(center_lon, center_lat, center_lon + 1.0, center_lat)[2]
    m_per_deg_lat = geod.inv(center_lon, center_lat, center_lon, center_lat + 1.0)[2]
    village_lon, village_lat = VILLAGE_WGS84

    config = {
        "schemaVersion": 1,
        "_doc": (
            "Terreno real Villafranca (IGN MDT05). Origen = esquina SW del mundo en WGS84; "
            "worldX=E-471500, worldZ=N-4689000; heights en metros ABSOLUTOS; el verticalDatum "
            "se resta al construir la malla y al devolver heightAt."
        ),
        "origin": {"lon": round(sw_lon, 8), "lat": round(sw_lat, 8)},
        "projection": {
            "metersPerDegreeLon": round(m_per_deg_lon, 2),
            "metersPerDegreeLat": round(m_per_deg_lat, 2),
        },
        "worldScale": 1,
        "verticalDatum": vertical_datum,
        "viewRadius": 900,
        "crs": f"EPSG:{CRS_EPSG}",
        "bounds": {"e": [E0, E0 + SIDE_M], "n": [N0, N0 + SIDE_M], "sampling": sampling},
        "spawn": {"lon": village_lon, "lat": village_lat},
        "tiles": tile_refs,
    }
    (out_dir / "config.json").write_text(
        json.dumps(config, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )

    # --- Aviso de atribución --------------------------------------------------
    (out_dir / "ATTRIBUTION.md").write_text(ATTRIBUTION, encoding="utf-8")

    # --- Chequeo cruzado DEM vs tiles (5 puntos) ------------------------------
    crosscheck = build_crosscheck(arr, sampling, n_rows, n_cols, tiles_dir, tiles_per_side, cells_per_tile, tile_size)

    # --- Presupuesto y radio de vista ----------------------------------------
    budget = build_budget(
        sampling, tile_size, tiles_per_side, cells_per_tile, tile_nodes,
        per_tile, total_triangles, total_vertices, total_json_bytes,
        vertical_datum, dem_min, dem_max, arr, crosscheck,
    )
    (out_dir / "budget.json").write_text(
        json.dumps(budget, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    DOCS_TERRAIN.mkdir(parents=True, exist_ok=True)
    (DOCS_TERRAIN / "crosscheck_dem_tiles.json").write_text(
        json.dumps(crosscheck, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )

    print(f"[ok] {tiles_per_side * tiles_per_side} tiles -> {tiles_dir}")
    print(f"[ok] config -> {out_dir / 'config.json'}")
    print(f"[ok] budget -> {out_dir / 'budget.json'}")
    print(f"[ok] verticalDatum={vertical_datum:.0f} m  DEM min/max={dem_min:.0f}/{dem_max:.0f} m")
    print(f"[ok] total {total_triangles} triángulos, {total_vertices} vértices, "
          f"{total_json_bytes / (1024*1024):.2f} MiB JSON")
    print(f"[ok] radio sugerido = {budget['radio_vista_sugerido_m']} m "
          f"(en vista: {budget['radio_vista_cuenta']['triangulos_max_en_vista']})")
    for p in crosscheck["puntos"]:
        print(f"     {p['nombre']:<22} E={p['e']:.1f} N={p['n']:.1f} "
              f"dem={p['dem_m']:.3f} tile={p['tile_m']:.3f} d={p['diff_m']:.4f}")
    if crosscheck["diff_max_abs_m"] > 1e-6:
        raise SystemExit("Chequeo DEM vs tiles falló: diferencia > 1e-6 m")
    return 0


def build_crosscheck(arr, sampling, n_rows, n_cols, tiles_dir, tiles_per_side, cells, tile_size):
    """5 puntos: pueblo + 2 cumbres + 2 bajos. DEM original vs tiles escritos."""
    # Nodos del DEM en coords de mundo (fila 0 = norte).
    e_axis = E0 + np.arange(n_cols) * sampling
    n_axis = N0 + SIDE_M - np.arange(n_rows) * sampling

    def far_mask(e0_, n0_, radius=1500.0):
        return ((np.abs(e_axis - e0_) > radius)[None, :] &
                (np.abs(n_axis - n0_) > radius)[:, None])

    rr, cc = np.unravel_index(np.argmax(arr), arr.shape)
    max_e, max_n = float(e_axis[cc]), float(n_axis[rr])
    r2, c2 = np.unravel_index(np.argmax(np.where(far_mask(max_e, max_n), arr, -np.inf)), arr.shape)
    max2_e, max2_n = float(e_axis[c2]), float(n_axis[r2])

    rmin, cmin = np.unravel_index(np.argmin(arr), arr.shape)
    min_e, min_n = float(e_axis[cmin]), float(n_axis[rmin])
    rmin2, cmin2 = np.unravel_index(np.argmin(np.where(far_mask(min_e, min_n), arr, np.inf)), arr.shape)
    min2_e, min2_n = float(e_axis[cmin2]), float(n_axis[rmin2])

    points = [
        ("pueblo_villafranca", *VILLAGE_EPSG25830),
        ("cumbre_max", max_e, max_n),
        ("cumbre_secundaria", max2_e, max2_n),
        ("punto_bajo_min", min_e, min_n),
        ("punto_bajo_secundario", min2_e, min2_n),
    ]

    # DEM de referencia: mismo campo de superficie que el motor, sobre el raster.
    # z0 del DEM = N0 (sur) y fila 0 = norte -> usar la grilla con z0 = N0.
    dem_surface = arr[::-1, :]  # fila 0 = sur, igual que el heightfield
    out_points = []
    max_diff = 0.0
    for name, e, n in points:
        wx = e - E0
        wz = n - N0
        dem_h = surface_meters(dem_surface, 0.0, 0.0, sampling, sampling, wx, wz)
        # Muestreo independiente desde los tiles ya escritos.
        tx = min(int(wx // tile_size), tiles_per_side - 1)
        tz = min(int(wz // tile_size), tiles_per_side - 1)
        raw = json.loads((tiles_dir / f"tile_{tx}_{tz}.json").read_text(encoding="utf-8"))
        g = raw["grid"]
        h = np.array(g["heights"], dtype=np.float64).reshape(g["rows"], g["columns"])
        tile_h = surface_meters(h, g["x0"], g["z0"], g["dx"], g["dz"], wx, wz)
        diff = tile_h - dem_h
        max_diff = max(max_diff, abs(diff))
        out_points.append({
            "nombre": name,
            "e": e,
            "n": n,
            "world_x": wx,
            "world_z": wz,
            "dem_m": round(dem_h, 4),
            "tile_m": round(tile_h, 4),
            "diff_m": round(diff, 6),
            "tile": f"tile_{tx}_{tz}",
        })
    return {
        "descripcion": "DEM original (interp. SW->NE) vs tile publicado (interp. SW->NE). "
                       "Diferencia debe ser ~0: valida orden de filas, recorte y no-resta de datum en el grid.",
        "diff_max_abs_m": round(max_diff, 8),
        "puntos": out_points,
    }


def build_budget(sampling, tile_size, tiles_per_side, cells, tile_nodes,
                 per_tile, total_triangles, total_vertices, total_json_bytes,
                 vertical_datum, dem_min, dem_max, arr, crosscheck):
    radius_candidates = [400, 500, 600, 700, 800, 900, 950, 997, 1000, 1100, 1200, 1500]
    # Nube de cámaras: pueblo + centro + 4 esquinas interiores del mapa.
    positions = [
        (VILLAGE_EPSG25830[0] - E0, VILLAGE_EPSG25830[1] - N0),
        (3000.0, 3000.0),
        (1000.0, 1000.0), (5000.0, 1000.0), (1000.0, 5000.0), (5000.0, 5000.0),
    ]

    def tile_aabb(ix, iz):
        x0 = ix * tile_size
        z0 = iz * tile_size
        c = int(round(x0 / sampling))
        r = int(round((SIDE_M - z0) / sampling))
        block = arr[r - cells:r + 1, c:c + tile_nodes]
        hmin = float(block.min())
        hmax = float(block.max())
        lo = (x0, hmin - vertical_datum, z0)
        hi = (x0 + tile_size, hmax - vertical_datum, z0 + tile_size)
        return lo, hi

    aabbs = {}
    for iz in range(tiles_per_side):
        for ix in range(tiles_per_side):
            aabbs[(ix, iz)] = tile_aabb(ix, iz)

    def count_for_radius(radius):
        # Disco completo (360°) por distancia AABB (desde el pueblo: caso peor de cobertura).
        disk = sum(
            1 for (ix, iz) in aabbs
            if aabb_distance(positions[0][0], positions[0][1], ix * tile_size, iz * tile_size, tile_size) <= radius
        )
        worst = 0
        worst_at = None
        typical = 0
        for (px, pz) in positions:
            ground = surface_meters(arr[::-1, :], 0.0, 0.0, sampling, sampling, px, pz)
            eye = (px, ground - vertical_datum + CAMERA_EYE_M, pz)
            for yaw_deg in range(0, 360, 10):
                yaw = math.radians(yaw_deg)
                target = (px + math.sin(yaw), eye[1], pz + math.cos(yaw))
                view = mat_look_at_lh(eye, target)
                proj = mat_perspective_fov_lh(CAMERA_FOV, CAMERA_ASPECT, 0.5, radius)
                planes = frustum_planes(mat_mul(view, proj))
                n = 0
                for (ix, iz), (lo, hi) in aabbs.items():
                    if aabb_distance(px, pz, ix * tile_size, iz * tile_size, tile_size) > radius:
                        continue
                    if aabb_in_frustum(planes, lo, hi):
                        n += 1
                if n > worst:
                    worst = n
                    worst_at = (px, pz, yaw_deg)
            target = (px, eye[1], pz + 1.0)
            view = mat_look_at_lh(eye, target)
            proj = mat_perspective_fov_lh(CAMERA_FOV, CAMERA_ASPECT, 0.5, radius)
            planes = frustum_planes(mat_mul(view, proj))
            n0 = sum(
                1 for (ix, iz), (lo, hi) in aabbs.items()
                if aabb_distance(px, pz, ix * tile_size, iz * tile_size, tile_size) <= radius
                and aabb_in_frustum(planes, lo, hi)
            )
            typical = max(typical, n0)
        return disk, worst, worst_at, typical

    tri_per_tile = cells * cells * 2
    per_radius = []
    for radius in radius_candidates:
        continuous = math.pi * radius ** 2 / (sampling ** 2) * 2
        disk, worst, worst_at, typical = count_for_radius(radius)
        per_radius.append({
            "radio_m": radius,
            "estimado_disco_continuo": int(round(continuous)),
            "tiles_disco_360": disk,
            "triangulos_disco_360": disk * tri_per_tile,
            "tiles_frustum_max": worst,
            "triangulos_frustum_max": worst * tri_per_tile,
            "frustum_max_desde": None if worst_at is None else {
                "x": round(worst_at[0], 1), "z": round(worst_at[1], 1), "yaw_deg": worst_at[2]},
            "tiles_frustum_norte": typical,
            "triangulos_frustum_norte": typical * tri_per_tile,
        })

    # Radio elegido: 900 m. Justificación (ver radio_vista_cuenta):
    #  - El estimado continuo del packet (πR²/25·2) a 900 m es 203.575 tris (< 250k).
    #  - En la vista por defecto (mirando al frente) quedan 3 tiles = 240.000 tris (<= 250k).
    #  - El peor caso simultáneo (esquina de 4 tiles, inevitable: el pueblo está a
    #    95 m de una esquina de tile) es 4 tiles = 320.000. Ningún radio lo evita con
    #    tiles de 1000 m y sin LOD; se documenta en "qué NO quedó".
    chosen = 900
    chosen_row = next(r for r in per_radius if r["radio_m"] == chosen)

    budget = {
        "generado_por": "scripts/terrain/build_terrain_tiles.py",
        "sampling_m": sampling,
        "tile_size_m": tile_size,
        "tiles_por_lado": tiles_per_side,
        "tiles": tiles_per_side * tiles_per_side,
        "nodos_por_tile": tile_nodes,
        "vertical_datum_m": vertical_datum,
        "dem": {"min_m": dem_min, "max_m": dem_max},
        "por_tile": {
            "columnas": tile_nodes,
            "filas": tile_nodes,
            "vertices": tile_nodes * tile_nodes,
            "triangulos": tri_per_tile,
            "json_bytes_promedio": int(total_json_bytes / (tiles_per_side * tiles_per_side)),
        },
        "totales": {
            "vertices": total_vertices,
            "triangulos": total_triangles,
            "json_bytes": total_json_bytes,
            "json_mib": round(total_json_bytes / (1024 * 1024), 2),
            "malla_runtime_mib": round(
                total_vertices * (3 + 3 + 4 + 2) * 4 / (1024 * 1024) +
                tiles_per_side * tiles_per_side * cells * cells * 6 * 2 / (1024 * 1024), 2),
        },
        "detalle_tiles": per_tile,
        "en_vista_por_radio": per_radius,
        "radio_vista_sugerido_m": chosen,
        "radio_vista_cuenta": {
            "formula_continua": "π·R²/sampling²·2",
            "estimado_disco_continuo": chosen_row["estimado_disco_continuo"],
            "tiles_frustum_max": chosen_row["tiles_frustum_max"],
            "triangulos_max_en_vista": chosen_row["triangulos_frustum_max"],
            "triangulos_frustum_norte": chosen_row["triangulos_frustum_norte"],
            "nota": (
                "El estimado continuo del packet (πR²/25·2) NO contempla la cuantización en "
                "tiles de 1000 m (80.000 tris c/u). A R=900 m: continuo 203.575; vista por "
                "defecto (al frente) 3 tiles = 240.000 (<=250.000); peor caso simultáneo en "
                "esquina de 4 tiles = 320.000. El conteo usa AABB exacto vs frustum de Babylon "
                "(port verificado contra la app)."
            ),
        },
        "cruces_dem_tiles_diff_max_m": crosscheck["diff_max_abs_m"],
    }
    return budget


ATTRIBUTION = """# Atribución — Terreno (IGN MDT05)

El terreno de este proyecto (`public/terrain/tiles/*.json`) se deriva del
**Modelo Digital del Terreno de paso de malla 5 m (MDT05)** del Instituto
Geográfico Nacional (IGN) / Centro Nacional de Información Geográfica (CNIG),
obtenido vía el WCS INSPIRE `https://servicios.idee.es/wcs-inspire/mdt`
(coverage `Elevacion25830_5`).

- **Titular:** © Instituto Geográfico Nacional (IGN) / CNIG.
- **Licencia:** CC BY 4.0 — https://creativecommons.org/licenses/by/4.0/
- **Origen de los datos:** vuelo LiDAR PNOA (PNOA-LiDAR).
- **Sistema de referencia:** EPSG:25830 (ETRS89 / UTM zona 30N).
- **Ventana:** E [471500, 477500] · N [4689000, 4695000] (6000 × 6000 m).

La atribución es **obligatoria** al distribuir el juego o cualquier captura o
asset derivado. Texto sugerido:

> Modelo Digital del Terreno © Instituto Geográfico Nacional (IGN-CNIG),
> CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/). Datos PNOA-LiDAR.

El detalle de la descarga (URL exacta, SHA256 y dimensiones) está en
`data/terrain/raw/fetch_manifest.json`.
"""


if __name__ == "__main__":
    raise SystemExit(main())
