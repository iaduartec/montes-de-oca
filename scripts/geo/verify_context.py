#!/usr/bin/env python3
"""Re-verificación del contexto geográfico citado en docs/geo/GEO_PLAN.md.

Todos los números que produce este script salen de los JSON crudos de Overpass
guardados en data/geo/raw/ (cada uno con su URL de consulta y SHA-256 en el
reporte). Método de distancia: proyección a EPSG:25830 con pyproj + distancia
punto→segmento en metros. Método de área: polígono en EPSG:25830 (UTM 30N).

Uso:
  .venv/bin/python scripts/geo/verify_context.py
Salida:
  data/geo/raw/geo_verification.json
"""
from __future__ import annotations

import json
import math
import os

from pyproj import Transformer
from shapely.geometry import Point, Polygon

HERE = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.abspath(os.path.join(HERE, "..", "..", "data", "geo", "raw"))

TR = Transformer.from_crs("EPSG:4326", "EPSG:25830", always_xy=True)
VILLAGE = (42.3883784, -3.3086147)  # lat, lon — Overpass node 492410655
BBOX = (42.350651, -3.350784, 42.404549, -3.277816)  # S, W, N, E


def load(name: str) -> dict:
    with open(os.path.join(RAW, name), encoding="utf-8") as fh:
        return json.load(fh)


def to_utm(geom: list[dict]) -> list[tuple[float, float]]:
    return [TR.transform(p["lon"], p["lat"]) for p in geom]


def min_dist_m(px: float, py: float, pts: list[tuple[float, float]]) -> float:
    """Distancia mínima punto→polilínea en metros (proyección UTM)."""
    best = math.inf
    for i in range(len(pts) - 1):
        ax, ay = pts[i]
        bx, by = pts[i + 1]
        dx, dy = bx - ax, by - ay
        l2 = dx * dx + dy * dy
        t = 0.0 if l2 == 0 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / l2))
        best = min(best, math.hypot(px - (ax + t * dx), py - (ay + t * dy)))
    return best


def bbox_poly():
    """bbox recortado al plano UTM (rectángulo rotado ~0.1° → casi recto)."""
    s, w_, n, e = BBOX
    corners = [(e, s), (w_, s), (w_, n), (e, n)]
    return Polygon([TR.transform(lon, lat) for lon, lat in corners])


def main() -> int:
    px, py = TR.transform(VILLAGE[1], VILLAGE[0])
    clip = bbox_poly()
    out: dict = {
        "metodo": {
            "proyeccion": "EPSG:25830 (ETRS89 / UTM 30N) vía pyproj.Transformer",
            "distancia": "punto→segmento en metros sobre la proyección UTM",
            "area": "shapely Polygon en EPSG:25830, dividido por 10000 → ha",
            "advertencia": "los tags OSM (surface, tracktype, access) son "
            "metadatos mapeados por humanos, NO mediciones",
        },
        "pueblo": {"lat": VILLAGE[0], "lon": VILLAGE[1], "utm30_e": round(px, 3), "utm30_n": round(py, 3)},
        "bbox_wgs84_S_W_N_E": list(BBOX),
    }

    # --- N-120 y A-12 dentro de 3 km --------------------------------------
    roads = load("osm_n120_a12_within3km.json")["elements"]
    rows = []
    for w in roads:
        if w.get("type") != "way" or not w.get("geometry"):
            continue
        t = w.get("tags", {})
        rows.append(
            {
                "osm_id": w["id"],
                "ref": t.get("ref"),
                "highway": t.get("highway"),
                "name": t.get("name"),
                "distance_m": round(min_dist_m(px, py, to_utm(w["geometry"])), 2),
                "maxspeed": t.get("maxspeed"),
                "lanes": t.get("lanes"),
                "surface": t.get("surface"),
            }
        )
    rows.sort(key=lambda r: r["distance_m"])
    out["viales_3km"] = rows[:10]
    out["n120_way_mas_cercano"] = rows[0]

    # --- A-12 en 40 km, por estado ----------------------------------------
    a12 = load("osm_a12_within40km.json")["elements"]
    best: dict[str, dict] = {}
    for w in a12:
        if w.get("type") != "way" or not w.get("geometry"):
            continue
        t = w.get("tags", {})
        hw, cons = t.get("highway"), t.get("construction")
        key = (
            "construction"
            if (hw == "construction" or cons)
            else ("proposed" if hw == "proposed" else hw)
        )
        d = min_dist_m(px, py, to_utm(w["geometry"]))
        if key not in best or d < best[key]["distance_m"]:
            best[key] = {
                "distance_m": round(d, 2),
                "distance_km": round(d / 1000.0, 3),
                "osm_id": w["id"],
                "name": t.get("name"),
                "n_ways": 1,
            }
        else:
            best[key]["n_ways"] += 1
    out["a12_por_estado"] = dict(sorted(best.items(), key=lambda kv: kv[1]["distance_m"]))

    # --- Cumbres dentro del bbox ------------------------------------------
    s, w_, n, e = BBOX
    peaks = []
    for p in load("osm_peaks_within20km.json")["elements"]:
        if p.get("type") != "node":
            continue
        lat, lon = p["lat"], p["lon"]
        if s <= lat <= n and w_ <= lon <= e:
            pt = TR.transform(lon, lat)
            peaks.append(
                {
                    "osm_id": p["id"],
                    "name": p.get("tags", {}).get("name"),
                    "ele_tag_m": p.get("tags", {}).get("ele"),
                    "dist_al_pueblo_m": round(math.hypot(pt[0] - px, pt[1] - py), 1),
                }
            )
    peaks.sort(key=lambda p: p["dist_al_pueblo_m"])
    out["cumbres_dentro_del_bbox"] = peaks

    # --- Camino de Santiago ------------------------------------------------
    # 1) relaciones cuyo *centro* cae a <40 km del pueblo
    caminos = []
    for el in load("osm_camino_relations_within40km.json")["elements"]:
        t = el.get("tags", {})
        c = el.get("center")
        if not c:
            continue
        cx, cy = TR.transform(c["lon"], c["lat"])
        caminos.append(
            {
                "osm_id": el["id"],
                "name": t.get("name"),
                "network": t.get("network"),
                "type": t.get("type"),
                "dist_centro_km": round(math.hypot(cx - px, cy - py) / 1000.0, 2),
            }
        )
    caminos.sort(key=lambda c: c["dist_centro_km"])
    out["relaciones_camino_40km"] = caminos

    # 2) Camino Francés rel 2163558: distancia real de sus ways al pueblo
    #    (el centro de la relación no sirve: abarca Logroño→Burgos)
    fr = [
        w
        for w in load("osm_camino_frances_rel2163558_ways.json")["elements"]
        if w.get("type") == "way" and w.get("geometry")
    ]
    near = []
    dentro = 0
    for w in fr:
        d = min_dist_m(px, py, to_utm(w["geometry"]))
        if d < 5000:
            near.append({"osm_id": w["id"], "name": w.get("tags", {}).get("name"), "dist_m": round(d, 1)})
        if any(s <= p["lat"] <= n and w_ <= p["lon"] <= e for p in w["geometry"]):
            dentro += 1
    near.sort(key=lambda r: r["dist_m"])
    out["camino_frances_rel_2163558"] = {
        "name": "Camino Francés - 03 Logroño a Burgos",
        "ways_totales": len(fr),
        "ways_con_vertice_dentro_del_bbox": dentro,
        "ways_mas_cercanos_al_pueblo": near[:5],
        "metodo": "distancia mínima punto→segmento en EPSG:25830 sobre los "
        "523 ways de la relación (data/geo/raw/osm_camino_frances_rel2163558_ways.json)",
    }
    # 3) resultado negativo: ways con tag network~Camino a <15 km del pueblo
    neg = load("osm_camino_network_ways_15km.json").get("elements", [])
    out["ways_tag_network_camino_15km"] = {
        "elements": len(neg),
        "nota": "0 elementos: el tag network=Camino sólo está en las "
        "relaciones, no en los ways sueltos. No sirve como filtro espacial.",
    }

    # --- Cobertura del suelo en el bbox -----------------------------------
    # Nota: el filtro bbox de Overpass devuelve ways que tocan el bbox aunque
    # se salgan, así que TODO se recorta al rectángulo del bbox antes de medir.
    forest = load("osm_forest_bbox.json")["elements"]
    seen: set[int] = set()
    f_areas: dict[str, dict] = {}
    f_polys: list[Polygon] = []
    for el in forest:
        if el.get("type") != "way" or el["id"] in seen or not el.get("geometry"):
            continue
        seen.add(el["id"])
        t = el.get("tags", {})
        key = t.get("natural") or t.get("landuse") or t.get("landcover") or "sin_tag"
        pts = to_utm(el["geometry"])
        if len(pts) < 3:
            continue
        pg = Polygon(pts)
        if not pg.is_valid:
            pg = pg.buffer(0)
        pg = pg.intersection(clip)
        if pg.is_empty:
            continue
        acc = f_areas.setdefault(key, {"ways": 0, "ha": 0.0})
        acc["ways"] += 1
        acc["ha"] += pg.area / 10000.0
        if key in ("wood", "forest", "sin_tag"):
            f_polys.append(pg)
    for v in f_areas.values():
        v["ha"] = round(v["ha"], 2)
    union = None
    if f_polys:
        from shapely.ops import unary_union

        union = unary_union(f_polys)
    out["bosque_bbox"] = {
        "por_tipo": f_areas,
        "ways_unicos": len(seen),
        "ha_suma_simple_recortada": round(sum(v["ha"] for v in f_areas.values()), 2),
        "ha_union_bosque_sin_solapes": round(union.area / 10000.0, 2) if union else None,
        "pct_del_bbox_union": round(100.0 * union.area / clip.area, 2) if union else None,
        "caveat": "recortado al bbox. OSM infraestaña el bosque acá: para la "
        "máscara de vegetación del juego usar CORINE Land Cover / ESA "
        "WorldCover y tratar OSM sólo como referencia de pistas.",
    }

    land = load("osm_landcover_bbox.json")["elements"]
    l_areas: dict[str, dict] = {}
    for el in land:
        if el.get("type") != "way" or not el.get("geometry"):
            continue
        t = el.get("tags", {})
        key = t.get("landuse") or t.get("natural") or t.get("landcover") or "sin_tag"
        pts = to_utm(el["geometry"])
        if len(pts) < 3:
            continue
        pg = Polygon(pts)
        if not pg.is_valid:
            pg = pg.buffer(0)
        pg = pg.intersection(clip)
        if pg.is_empty:
            continue
        acc = l_areas.setdefault(key, {"ways": 0, "ha": 0.0})
        acc["ways"] += 1
        acc["ha"] += pg.area / 10000.0
    for v in l_areas.values():
        v["ha"] = round(v["ha"], 2)
    out["landcover_bbox"] = l_areas
    out["bbox_ha"] = round(clip.area / 10000.0, 2)

    dest = os.path.join(RAW, "geo_verification.json")
    with open(dest, "w", encoding="utf-8") as fh:
        json.dump(out, fh, ensure_ascii=False, indent=2)
    print(f"wrote {dest}")
    print(json.dumps(out, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
