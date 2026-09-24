#!/usr/bin/env python3
"""Estadísticas de la red viaria OSM dentro del bbox jugable.

Entrada : data/geo/raw/osm_highways_bbox.geojson.json (Overpass `out tags geom`)
Salida  : data/geo/raw/osm_highways_stats.json (extracto normalizado)

Regla del proyecto: los tags de OSM son METADATOS MAPEADOS, no mediciones.
Ningún número de este script se reporta como "medido".
"""
from __future__ import annotations

import hashlib
import json
import math
import sys
from collections import Counter, defaultdict
from pathlib import Path

from shapely.geometry import LineString, box

RAW = Path(__file__).resolve().parents[2] / "data" / "geo" / "raw"
SRC = RAW / "osm_highways_bbox.geojson.json"
OUT = RAW / "osm_highways_stats.json"

# Centro y escala local (metros por grado) para EPSG:4326 -> metros locales
LAT0 = 42.3776
LON0 = -3.3143
MPD_LAT = 111320.0
MPD_LON = 111320.0 * math.cos(math.radians(LAT0))

BBOX = (42.350651, -3.350784, 42.404549, -3.277816)  # S, W, N, E
CLIP = box(BBOX[1], BBOX[0], BBOX[3], BBOX[2])


def way_length_m(geom: list[dict]) -> float:
    """Longitud RECORTEADA al bbox.

    Overpass devuelve la geometría completa de una way si ésta toca el bbox,
    así que sin este recorte las longitudes se inflan (p.ej. la A-12
    propuesta o la N-120, cuyas ways cruzan de punta a punta).
    """
    if len(geom) < 2:
        return 0.0
    ll = [(p["lon"], p["lat"]) for p in geom]
    try:
        line = LineString(ll).intersection(CLIP)
    except Exception:
        return 0.0
    if line.is_empty:
        return 0.0
    geoms = getattr(line, "geoms", [line])
    total = 0.0
    for g in geoms:
        if g.geom_type != "LineString":
            continue
        for (x1, y1), (x2, y2) in zip(g.coords, list(g.coords)[1:]):
            total += math.hypot((x2 - x1) * MPD_LON, (y2 - y1) * MPD_LAT)
    return total


def main() -> int:
    raw = SRC.read_bytes()
    data = json.loads(raw)

    by_class: Counter[str] = Counter()
    len_by_class: dict[str, float] = defaultdict(float)
    tracktype: Counter[str] = Counter()
    covered = Counter()
    total = 0
    total_len = 0.0
    nameless = 0
    access_vals: Counter[str] = Counter()

    for el in data["elements"]:
        tags = el.get("tags") or {}
        hw = tags.get("highway")
        if hw is None:
            continue
        total += 1
        geom = el.get("geometry") or []
        ln = way_length_m(geom) if len(geom) > 1 else 0.0
        total_len += ln

        if hw == "track":
            sub = f"track/{tags.get('tracktype', 'sin-tracktype')}"
            tracktype[tags.get("tracktype", "sin-tracktype")] += 1
        elif hw == "path":
            sub = "path"
        else:
            sub = hw
        by_class[sub] += 1
        len_by_class[sub] += ln

        if "surface" in tags:
            covered["surface"] += 1
        if "smoothness" in tags:
            covered["smoothness"] += 1
        if "access" in tags:
            covered["access"] += 1
            access_vals[tags["access"]] += 1
        if "motor_vehicle" in tags or "motorcar" in tags:
            covered["motor_vehicle/motorcar"] += 1
        if "name" not in tags:
            nameless += 1

    # Longitud por familia pedida en el packet
    def cnt(*keys: str) -> int:
        return sum(v for k, v in by_class.items() if k.split("/")[0] in keys)

    def lng(*keys: str) -> float:
        return sum(v for k, v in len_by_class.items() if k.split("/")[0] in keys)

    families = {}
    for fam in [
        "primary", "secondary", "tertiary", "unclassified", "residential",
        "service", "track", "path", "footway", "bridleway",
    ]:
        families[fam] = {
            "ways": cnt(fam),
            "km": round(lng(fam) / 1000.0, 3),
        }

    payload = {
        "source_file": SRC.name,
        "source_sha256": hashlib.sha256(raw).hexdigest(),
        "source_bytes": len(raw),
        "overpass_timestamp": data.get("osm3s", {}).get("timestamp_osm_base"),
        "bbox": [42.350651, -3.350784, 42.404549, -3.277816],
        "caveat": "Tags OSM = metadatos mapeados, no mediciones.",
        "total_ways_highway": total,
        "total_length_km": round(total_len / 1000.0, 3),
        "ways_sin_nombre": nameless,
        "por_familia": families,
        "por_subclase": dict(sorted(by_class.items(), key=lambda kv: -kv[1])),
        "tracktype": dict(tracktype),
        "cobertura_tags": {
            k: {"ways": v, "pct": round(100.0 * v / total, 1) if total else 0.0}
            for k, v in sorted(covered.items())
        },
        "valores_access": dict(access_vals),
        "longitud_km_por_subclase": {
            k: round(v / 1000.0, 3)
            for k, v in sorted(len_by_class.items(), key=lambda kv: -kv[1])
        },
    }
    OUT.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    print(f"\n=> escrito {OUT}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
