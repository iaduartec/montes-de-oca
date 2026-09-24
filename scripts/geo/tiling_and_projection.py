#!/usr/bin/env python3
"""Números de proyección/origen local y de tiling para el bbox jugable 6x6 km.

Salida: data/geo/raw/tiling_projection.json

Todo se calcula aquí para que cada cifra del informe GEO_PLAN.md sea trazable a
este script. Fuentes de datos: pyproj (EPSG oficial) y aritmética de mallas.
"""
from __future__ import annotations

import json
import math
from pathlib import Path

from pyproj import CRS, Transformer

OUT = Path(__file__).resolve().parents[2] / "data" / "geo" / "raw" / "tiling_projection.json"

# --- Verdad de campo (Overpass node 492410655) -----------------------------
VILLAGE = (-3.3086147, 42.3883784)          # lon, lat  (WGS84)
PACKET = (-3.4140, 42.3865)                 # coordenada erronea del packet
BBOX_WGS84 = (42.350651, -3.350784, 42.404549, -3.277816)  # S, W, N, E
SIDE_M = 6000.0

# --- Convencion del proyecto de referencia (Shenzhen) ---------------------
REF_ORIGIN = (114.025, 22.536)
REF_LON_FACTOR = 102850.0
REF_LAT_FACTOR = 111320.0
REF_SCALE = 0.60


def main() -> int:
    t25830 = Transformer.from_crs("EPSG:4326", "EPSG:25830", always_xy=True)

    # 1) Coordenadas clave en UTM 30N
    ve, vn = t25830.transform(*VILLAGE)
    pe, pn = t25830.transform(*PACKET)
    corners_ll = [
        (-3.350784, 42.350651),  # SO
        (-3.277816, 42.350651),  # SE
        (-3.277816, 42.404549),  # NE
        (-3.350784, 42.404549),  # NO
    ]
    corners_utm = [t25830.transform(*c) for c in corners_ll]

    # 2) Factores locales metros/grado
    lat0 = (BBOX_WGS84[0] + BBOX_WGS84[2]) / 2.0
    lon0 = (BBOX_WGS84[1] + BBOX_WGS84[3]) / 2.0
    m_per_deg_lat = 111320.0
    m_per_deg_lon = 111320.0 * math.cos(math.radians(lat0))

    # 3) Equirectangular exacto (factor local) vs UTM 30N en las esquinas
    equirect_err = []
    for (lo, la), (e, n) in zip(corners_ll, corners_utm):
        # proyección local exacta al centro del bbox
        x = (lo - lon0) * m_per_deg_lon
        y = (la - lat0) * m_per_deg_lat
        # UTM respecto al centro del bbox
        ce, cn = t25830.transform(lon0, lat0)
        dx, dy = (e - ce) - x, (n - cn) - y
        equirect_err.append(math.hypot(dx, dy))

    # 4) Error de reusar tal cual la convención de Shenzhen (lat 22.536)
    ref_factor_error_pct = abs(m_per_deg_lon - REF_LON_FACTOR) / REF_LON_FACTOR * 100.0

    # 5) ¿Qué pasa si proyectamos Burgos en EPSG:32649 (huso 49N, meridiano 111 E)?
    t32649 = Transformer.from_crs("EPSG:4326", "EPSG:32649", always_xy=True)
    try:
        e49, n49 = t32649.transform(*VILLAGE)
        zone49 = CRS.from_epsg(32649)
        aoi = zone49.area_of_use
        utm49 = {
            "easting": round(e49, 3),
            "northing": round(n49, 3),
            "area_of_use": f"{aoi.west}, {aoi.south}, {aoi.east}, {aoi.north}" if aoi else None,
            "distancia_al_centro_de_huso_grados": round(abs(VILLAGE[0] - 111.0), 3),
        }
    except Exception as exc:  # pragma: no cover
        utm49 = {"error": str(exc)}

    # --- Tiling -------------------------------------------------------------
    def tile_axis(side: float, tile: float) -> dict:
        q, r = divmod(side, tile)
        return {
            "tiles_por_lado": q + (1 if r else 0),
            "tile_ultimo_parcial_m": round(r, 3) if r else tile,
            "cobertura_total_m": round((q + (1 if r else 0)) * tile, 3),
        }

    def option(tile: float, d: float) -> dict:
        cells = tile / d
        integer_cells = float(cells).is_integer()
        c = int(round(cells))
        verts = (c + 1) ** 2
        quads = c * c
        u16_ok = verts <= 65536
        h_b = verts * 4                      # float32 por vertice
        i_b = quads * 6 * (2 if u16_ok else 4)
        return {
            "tile_m": tile,
            "muestreo_m": d,
            "celdas_por_lado_entero": integer_cells,
            "celdas_por_lado": c,
            "vertices_por_tile": verts,
            "triangulos_por_tile": quads * 2,
            "indices_u16_caben": u16_ok,
            "bytes_alturas_f32_por_tile": h_b,
            "bytes_indices_por_tile": i_b,
            "bytes_malla_por_tile": h_b + i_b,
            "pixels_texture_height_por_tile": (c + 1),
        }

    axis512 = tile_axis(SIDE_M, 512.0)
    axis1024 = tile_axis(SIDE_M, 1024.0)
    axis512_aligned = tile_axis(6144.0, 512.0)
    axis1024_aligned = tile_axis(6144.0, 1024.0)

    options = []
    for tile in (512.0, 1024.0):
        n_tiles = (int(round(SIDE_M / tile)) if (SIDE_M % tile == 0) else
                   math.ceil(SIDE_M / tile)) ** 2
        n_tiles_aligned = int(6144.0 / tile) ** 2
        for d in (2.0, 4.0, 5.0, 8.0, 10.0):
            o = option(tile, d)
            o["tiles_totales_6000m"] = n_tiles
            o["tiles_totales_6144m_alineado"] = n_tiles_aligned
            o["vertices_totales_6000m"] = o["vertices_por_tile"] * n_tiles
            o["triangulos_totales_6000m"] = o["triangulos_por_tile"] * n_tiles
            o["mib_totales_malla_6000m"] = round(
                o["bytes_malla_por_tile"] * n_tiles / (1024 * 1024), 2)
            # tiles y triangulos en pantalla con radio de visión de 1000 m
            per_axis = math.ceil(2 * 1000.0 / tile) + 1
            o["tiles_en_vista_radio_1000m"] = per_axis ** 2
            o["triangulos_en_vista_radio_1000m"] = per_axis ** 2 * o["triangulos_por_tile"]
            options.append(o)

    # Presupuestos existentes del proyecto de referencia (audit W1/W2)
    budgets = {
        "ground_relief_triangulos_max": 200000,       # src/city-ground-relief.ts:74
        "ground_relief_tiles_max": 100,               # src/city-ground-relief.ts:74
        "mountains_triangulos_max": 260000,           # src/city-mountains.ts:20 y prepare_city_mountains.py:80
        "mountains_tiles_max": 180,                   # src/city-mountains.ts:20
        # La grilla de bloques es de 640 unidades de juego; a escala 0.6 eso son
        # 1066.7 m reales. NO es un radio de culling: los radios reales de
        # city-world.ts:435 son 700 (detalle) / 2500 (carreteras) / 3300 (bloques).
        "grilla_bloques_unidades_juego": 640,         # src/city-world.ts:253
        "grilla_bloques_m_reales_a_escala_0_6": round(640 / REF_SCALE, 1),
        "radios_culling_unidades_juego": {"detalle": 700, "carreteras": 2500, "bloques": 3300},
        "chunk_ground_relief_unidades_juego": 1280,   # prepare_city_ground_relief.py:123
        "chunk_ground_relief_m_reales": round(1280 / REF_SCALE, 1),
        "unica_capa_stream_existente": "CityFacadeStream, radios 700 (load) / 700 (visible) / 1500 (evict) en src/city-facade-stream.ts:10,21,33",
    }

    payload = {
        "proyeccion": {
            "crs_recomendado": "EPSG:25830 (ETRS89 / UTM zona 30N)",
            "unidades": CRS.from_epsg(25830).axis_info[0].unit_name,
            "pueblo_epsg25830": {"easting": round(ve, 3), "northing": round(vn, 3)},
            "punto_erroneo_del_packet_epsg25830": {"easting": round(pe, 3), "northing": round(pn, 3)},
            "desvio_packet_vs_real_m": round(math.hypot(pe - ve, pn - vn), 1),
            "bbox_esquinas_epsg25830": [[round(e, 3), round(n, 3)] for e, n in corners_utm],
            "ancho_bbox_utm_m": round(
                math.hypot(corners_utm[1][0] - corners_utm[0][0],
                           corners_utm[1][1] - corners_utm[0][1]), 2),
            "alto_bbox_utm_m": round(
                math.hypot(corners_utm[3][0] - corners_utm[0][0],
                           corners_utm[3][1] - corners_utm[0][1]), 2),
            "metros_por_grado_lon_lat": {"lon": round(m_per_deg_lon, 1), "lat": m_per_deg_lat},
            "error_equirect_local_vs_utm_en_esquinas_m": [round(v, 3) for v in equirect_err],
            "error_equirect_local_vs_utm_max_m": round(max(equirect_err), 3),
            "error_reusar_factor_lon_de_shenzhen_pct": round(ref_factor_error_pct, 2),
            "factor_lon_correcto_para_espana": round(m_per_deg_lon, 1),
            "convencion_referencia": {
                "origen_wgs84": list(REF_ORIGIN),
                "factor_lon": REF_LON_FACTOR,
                "factor_lat": REF_LAT_FACTOR,
                "escala": REF_SCALE,
                "formula": "east=(lon-114.025)*102850*0.60 ; north=(lat-22.536)*111320*0.60",
            },
            "epsg32649_para_burgos": utm49,
        },
        "tiling": {
            "lado_declarado_m": SIDE_M,
            "eje_512_en_6000m": axis512,
            "eje_1024_en_6000m": axis1024,
            "eje_512_en_6144m_alineado": axis512_aligned,
            "eje_1024_en_6144m_alineado": axis1024_aligned,
            "presupuestos_existentes": budgets,
            "opciones": options,
        },
    }
    OUT.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    print(f"\n=> escrito {OUT}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
