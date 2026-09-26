#!/usr/bin/env python3
"""Constructor de la capa de agua: láminas, cota del vaso y grilla de profundidad.

Entrada : data/water/raw/osm_water_window.json (+ manifiesto con sha256)
          public/terrain/tiles/tile_*.json (DEM, alturas ABSOLUTAS en metros)
Salida  : public/water/water.json (láminas trianguladas + cota + grilla)
          public/water/stats.json (conteos y medidas para el reporte)

Sin dependencias: solo stdlib. La Tarea 3 rellenará `ribbons` y `dam` en este
mismo archivo; por eso el esquema ya incluye ambas claves.

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

# --- Anillo del embalse (Embalse de Alba, relation OSM 18149353) ---
#
# POR QUÉ ESTÁ INCRUSTADO: el crudo de la Tarea 1 (`out geom tags` sobre la
# ventana) trae la relation del embalse SIN miembros ni geometría, y sus 22
# ways de contorno no están entre los 102 elementos (solo vienen como relation
# con bounds). Sin anillo no hay lámina del vaso, que es la pieza mayor del
# plan. Los 22 ways (`source=ITACyL`) se obtuvieron de Overpass con
# `(relation(18149353);way(r););out geom tags;`, se unieron por extremos en un
# único anillo cerrado y se proyectaron a metros de mundo (ver to_world).
# Si la Tarea 1 se completa con recursión (`way(r)`), este literal podrá
# sustituirse por el ensamblado desde el crudo sin cambiar el resto.
# Miembros: 168459090, 1323054276, 1323054277, 1323054292, 1323054293,
# 1323054295, 1323054296, 1323054298, 1323054300, 1323054304, 1323054305,
# 1323054308, 1323056448, 1323056461, 1323077137, 1323077164, 1323077179,
# 1323077182, 1323077185, 1323077193, 1323077196, 1323077197.
RESERVOIR_RING = [[2696.78, 1008.34], [2690.45, 992.40], [2683.31, 974.63], [2669.74, 953.63], [2664.31, 943.17], [2663.06, 934.02], [2661.46, 923.58], [2658.00, 918.31], [2662.25, 906.15], [2661.46, 896.18], [2659.61, 884.59], [2658.92, 874.96], [2656.51, 872.89], [2651.33, 869.56], [2647.88, 865.66], [2641.43, 857.98], [2637.40, 852.47], [2633.95, 846.74], [2634.53, 843.75], [2637.75, 840.54], [2638.78, 838.36], [2638.32, 832.74], [2637.51, 827.12], [2643.23, 808.83], [2646.65, 797.31], [2651.20, 790.01], [2664.06, 781.58], [2670.57, 778.00], [2675.94, 772.32], [2680.33, 767.30], [2683.10, 756.76], [2683.43, 750.10], [2684.89, 741.99], [2689.12, 730.80], [2689.28, 720.58], [2686.52, 710.84], [2682.13, 703.71], [2676.91, 699.34], [2670.41, 696.57], [2662.59, 694.62], [2652.50, 690.40], [2645.67, 686.03], [2644.53, 681.48], [2649.57, 680.03], [2652.18, 682.31], [2656.90, 680.35], [2659.34, 676.46], [2663.54, 676.11], [2669.81, 669.61], [2673.33, 662.83], [2674.80, 659.75], [2688.30, 661.70], [2690.58, 660.40], [2691.89, 655.37], [2688.47, 645.16], [2690.10, 638.66], [2694.17, 629.09], [2699.05, 620.01], [2692.05, 618.23], [2692.05, 614.65], [2698.24, 611.90], [2705.07, 607.35], [2708.49, 599.56], [2711.09, 592.11], [2712.23, 583.19], [2712.06, 577.02], [2707.51, 571.50], [2705.92, 560.39], [2705.24, 550.31], [2701.32, 543.19], [2698.33, 532.63], [2702.01, 528.28], [2706.38, 531.94], [2708.23, 529.89], [2715.82, 517.50], [2725.26, 508.78], [2735.16, 502.58], [2755.87, 489.51], [2763.23, 485.38], [2771.75, 474.82], [2776.58, 464.28], [2785.10, 453.04], [2795.22, 441.79], [2801.21, 426.87], [2802.82, 414.27], [2807.41, 406.69], [2813.63, 400.50], [2816.42, 398.66], [2824.29, 396.13], [2827.22, 393.53], [2831.29, 388.34], [2834.06, 382.66], [2826.57, 384.44], [2819.41, 386.87], [2819.74, 384.12], [2820.71, 378.12], [2822.82, 369.52], [2825.59, 362.22], [2823.80, 356.87], [2820.45, 353.82], [2817.30, 353.13], [2807.69, 360.28], [2803.78, 367.24], [2803.63, 376.95], [2797.19, 388.88], [2792.59, 397.82], [2785.45, 407.46], [2784.31, 418.93], [2776.70, 433.15], [2770.26, 439.35], [2761.29, 449.90], [2756.68, 456.09], [2749.78, 461.15], [2742.64, 463.67], [2729.75, 466.42], [2713.64, 474.68], [2705.36, 481.10], [2697.77, 489.13], [2687.87, 495.33], [2668.08, 511.15], [2659.79, 519.41], [2652.43, 529.73], [2649.66, 538.45], [2645.75, 549.92], [2645.52, 560.25], [2650.58, 570.11], [2654.50, 577.68], [2654.73, 588.00], [2655.19, 600.62], [2655.19, 609.57], [2654.96, 617.59], [2659.10, 622.42], [2655.65, 626.77], [2651.05, 629.07], [2646.21, 631.36], [2640.69, 635.72], [2635.63, 642.83], [2631.95, 651.54], [2626.65, 661.19], [2624.35, 667.61], [2618.14, 678.39], [2612.15, 687.79], [2610.08, 696.75], [2615.15, 702.25], [2617.68, 706.15], [2613.62, 710.52], [2615.22, 719.01], [2619.82, 724.75], [2629.95, 735.31], [2636.63, 738.28], [2637.78, 741.49], [2636.17, 746.32], [2634.56, 751.59], [2629.95, 754.57], [2628.11, 757.56], [2628.11, 760.99], [2625.58, 763.06], [2621.21, 763.75], [2616.84, 766.04], [2613.15, 771.32], [2608.09, 778.20], [2600.50, 784.40], [2594.97, 783.02], [2584.62, 783.02], [2581.17, 784.62], [2573.57, 791.51], [2565.51, 798.62], [2556.53, 801.37], [2545.95, 802.52], [2541.81, 801.59], [2536.05, 798.16], [2530.07, 788.99], [2525.47, 781.41], [2520.87, 778.89], [2519.02, 788.99], [2521.10, 797.01], [2524.32, 806.18], [2529.61, 812.15], [2535.13, 813.07], [2536.98, 819.04], [2542.50, 824.08], [2556.07, 829.59], [2561.14, 831.64], [2562.52, 837.15], [2569.19, 837.84], [2576.79, 841.74], [2579.32, 849.09], [2581.85, 855.27], [2577.48, 861.24], [2574.49, 866.29], [2570.81, 873.17], [2566.66, 880.73], [2558.84, 891.29], [2550.56, 903.67], [2548.25, 914.01], [2545.49, 930.06], [2541.81, 945.89], [2532.60, 959.42], [2522.02, 969.28], [2503.84, 983.05], [2487.96, 994.98], [2470.70, 1002.78], [2452.74, 1010.58], [2436.63, 1017.23], [2425.35, 1017.45], [2408.10, 1014.02], [2395.66, 1010.34], [2377.02, 1004.38], [2364.37, 997.05], [2353.09, 990.39], [2326.39, 981.90], [2303.83, 967.45], [2292.66, 964.45], [2290.08, 959.82], [2290.02, 954.14], [2291.18, 942.22], [2265.17, 930.29], [2249.75, 926.85], [2248.37, 928.91], [2246.76, 934.88], [2243.31, 935.79], [2235.48, 927.54], [2222.59, 920.19], [2211.09, 919.51], [2200.27, 923.87], [2193.13, 930.75], [2187.38, 941.76], [2183.93, 953.92], [2188.99, 960.11], [2194.28, 968.83], [2203.49, 975.71], [2220.06, 983.97], [2233.64, 990.39], [2238.71, 992.91], [2245.61, 990.61], [2254.35, 986.49], [2258.04, 989.25], [2269.77, 988.33], [2272.99, 993.37], [2278.75, 1007.13], [2287.03, 1021.35], [2285.88, 1032.14], [2289.57, 1041.55], [2296.70, 1066.54], [2301.54, 1078.93], [2303.98, 1086.17], [2309.82, 1103.48], [2313.04, 1122.98], [2311.43, 1134.91], [2305.91, 1149.13], [2296.32, 1162.36], [2278.60, 1188.51], [2266.63, 1205.94], [2256.04, 1223.60], [2248.91, 1234.16], [2244.08, 1241.96], [2236.94, 1247.92], [2221.98, 1258.48], [2215.76, 1269.48], [2207.03, 1278.43], [2196.90, 1286.91], [2189.30, 1292.42], [2183.08, 1294.71], [2175.03, 1294.95], [2166.28, 1296.32], [2152.93, 1296.09], [2145.62, 1300.12], [2142.35, 1309.39], [2136.13, 1323.62], [2135.44, 1331.42], [2137.06, 1341.28], [2140.97, 1349.77], [2144.42, 1356.19], [2145.57, 1366.51], [2141.20, 1380.50], [2139.59, 1390.14], [2138.90, 1395.18], [2135.22, 1401.84], [2127.39, 1408.95], [2118.64, 1416.06], [2111.51, 1428.90], [2108.52, 1449.32], [2105.76, 1469.50], [2104.15, 1487.85], [2102.76, 1500.46], [2098.39, 1510.56], [2089.41, 1522.72], [2083.43, 1529.59], [2074.92, 1537.39], [2069.62, 1541.52], [2065.02, 1550.93], [2055.81, 1559.42], [2044.31, 1566.98], [2034.41, 1575.71], [2024.75, 1585.10], [2013.46, 1597.26], [1998.74, 1611.02], [1991.61, 1617.68], [1985.16, 1624.33], [1982.17, 1632.35], [1982.17, 1639.00], [1985.85, 1646.11], [1989.99, 1650.70], [1996.43, 1654.15], [2005.41, 1655.98], [2016.46, 1655.98], [2025.89, 1653.91], [2043.15, 1648.64], [2076.29, 1640.62], [2092.18, 1633.27], [2100.23, 1628.68], [2113.12, 1618.82], [2120.49, 1613.54], [2127.39, 1612.16], [2133.37, 1614.01], [2140.28, 1614.46], [2152.70, 1611.94], [2163.52, 1609.88], [2177.34, 1602.53], [2199.42, 1594.97], [2217.38, 1589.92], [2227.51, 1585.79], [2238.78, 1578.92], [2248.45, 1573.64], [2263.87, 1566.98], [2276.06, 1565.61], [2287.35, 1559.19], [2295.63, 1556.21], [2302.53, 1553.22], [2305.06, 1552.31], [2311.05, 1545.66], [2318.18, 1541.07], [2323.25, 1543.82], [2329.23, 1546.11], [2339.58, 1554.60], [2344.88, 1560.56], [2350.41, 1566.30], [2364.79, 1581.13], [2365.44, 1571.23], [2366.57, 1559.15], [2369.75, 1544.63], [2374.47, 1532.30], [2380.16, 1520.87], [2385.94, 1510.74], [2393.59, 1500.44], [2402.05, 1491.68], [2411.34, 1484.06], [2430.21, 1471.57], [2440.95, 1466.86], [2453.32, 1462.73], [2469.59, 1459.07], [2482.85, 1457.94], [2495.79, 1457.69], [2496.04, 1450.56], [2497.25, 1444.81], [2501.24, 1438.64], [2504.82, 1433.61], [2508.97, 1429.64], [2509.30, 1426.31], [2507.34, 1419.13], [2507.46, 1411.46], [2509.88, 1406.06], [2515.28, 1401.94], [2522.88, 1398.73], [2525.99, 1396.08], [2525.64, 1391.04], [2524.95, 1385.76], [2522.54, 1380.14], [2522.19, 1373.83], [2523.00, 1368.68], [2524.61, 1364.89], [2524.72, 1360.65], [2522.54, 1356.29], [2520.12, 1351.36], [2517.70, 1344.70], [2520.92, 1336.56], [2522.65, 1330.72], [2523.23, 1322.80], [2524.61, 1317.06], [2528.29, 1304.22], [2533.47, 1291.95], [2535.31, 1279.56], [2537.96, 1267.28], [2542.67, 1257.20], [2547.28, 1241.71], [2550.38, 1231.28], [2551.19, 1225.88], [2551.19, 1215.67], [2553.95, 1209.37], [2558.90, 1205.13], [2563.04, 1197.21], [2565.35, 1191.13], [2571.21, 1187.69], [2574.55, 1182.99], [2580.88, 1175.77], [2584.56, 1172.32], [2587.66, 1173.12], [2588.13, 1176.22], [2592.04, 1175.08], [2600.44, 1172.78], [2604.00, 1169.23], [2601.13, 1166.81], [2595.83, 1164.42], [2595.37, 1160.97], [2597.56, 1157.29], [2601.94, 1152.25], [2607.35, 1149.15], [2609.88, 1145.49], [2611.62, 1141.16], [2616.46, 1137.83], [2620.25, 1131.75], [2624.05, 1128.20], [2624.97, 1121.67], [2626.47, 1115.94], [2629.69, 1112.95], [2633.49, 1102.86], [2637.75, 1100.90], [2640.62, 1101.48], [2644.76, 1098.04], [2652.13, 1088.97], [2658.46, 1081.64], [2662.72, 1079.23], [2666.28, 1077.05], [2668.70, 1073.03], [2673.19, 1064.78], [2678.48, 1057.32], [2684.35, 1049.87], [2687.80, 1046.54], [2693.67, 1044.13], [2696.43, 1042.53], [2699.77, 1039.32], [2702.65, 1037.48], [2702.19, 1032.66], [2703.69, 1027.04], [2707.48, 1026.46], [2710.01, 1028.65], [2707.02, 1023.83], [2701.04, 1021.53], [2698.16, 1018.66], [2697.82, 1013.85]]


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
    raw: dict, proj: dict, origin: dict, index: dict, pool: float
) -> tuple[list[dict], list[dict]]:
    """Láminas: embalse (anillo OSM §arriba) + laguna/charcas/pilón del crudo.

    Devuelve (sheets, descartadas). Un anillo degenerado tras el recorte
    (<3 vértices) se descarta y se cuenta, nunca se silencia.
    """
    sheets: list[dict] = []
    dropped: list[dict] = []

    def add_sheet(sid: str, kind: str, name: str, ring_world: list, level: float):
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
        [tuple(p) for p in RESERVOIR_RING],
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
        add_sheet(
            slug(tags.get("name", ""), f"water-{el.get('id')}"),
            kind,
            tags.get("name", f"water-{el.get('id')}"),
            ring,
            shore[len(shore) // 2] + 0.15,
        )
    return sheets, dropped


def build_dam(
    raw: dict, proj: dict, origin: dict, index: dict, level: float
) -> tuple[dict, list]:
    """Muro de la presa desde el way waterway=dam (la Tarea 3 lo completará)."""
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

    clipped_reservoir = clip_ring_to_window([tuple(p) for p in RESERVOIR_RING])
    if len(clipped_reservoir) < 3:
        raise ValueError("el anillo del embalse queda degenerado tras el recorte")
    pool = pool_level(index, clipped_reservoir, FALLBACK_LEVEL_M)
    level = round(pool + 0.15, 2)

    dam, dam_pts = build_dam(raw, proj, origin, index, level)
    global DAM_LINE
    DAM_LINE = [(dam["a"][0], dam["a"][1]), (dam["b"][0], dam["b"][1])]

    res_ring = [[round(p[0], 2), round(p[1], 2)] for p in clipped_reservoir]
    grid = depth_grid(index, res_ring, level)

    sheets, dropped = build_sheets(raw, proj, origin, index, pool)
    reservoir = next(s for s in sheets if s["id"] == "embalse-alba")

    payload = {
        "schemaVersion": 1,
        "meta": {
            "generadoPor": "scripts/water/build_water.py",
            "sourceSha256": manifest["sha256"],
            "scriptSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        },
        "levelM": level,
        "sheets": sheets,
        "ribbons": [],  # Tarea 3: cintas de río y arroyos
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
        "sourceSha256": manifest["sha256"],
    }
    _ = reservoir, dam_pts
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
            g = payload["depthGrid"]
            print(
                f"[agua] OK: water.json + stats.json coinciden "
                f"({n} láminas, cota {payload['levelM']}, "
                f"grilla {g['cols']}x{g['rows']}, máx {g['maxDepthM']} m)"
            )
        return 0 if ok else 1
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for name, blob in blobs.items():
        (OUT_DIR / name).write_bytes(blob)
    n = len(payload["sheets"])
    g = payload["depthGrid"]
    print(
        f"[agua] {n} láminas · cota {payload['levelM']} m · "
        f"grilla {g['cols']}x{g['rows']} · máx {g['maxDepthM']} m · "
        f"descartadas {len(stats['descartadas'])}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
