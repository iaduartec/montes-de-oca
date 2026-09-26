#!/usr/bin/env python3
"""Descarga el agua de OSM dentro de la ventana jugable y la versiona cruda.

Mismo patrón que data/roads/raw: consulta + JSON crudo + manifiesto con sha256.
Sin dependencias: urllib de la stdlib.
"""

from __future__ import annotations
import hashlib, json, socket, sys, urllib.error, urllib.parse, urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CONFIG = ROOT / "public" / "terrain" / "config.json"
OUT_DIR = ROOT / "data" / "water" / "raw"
QUERY_FILE = OUT_DIR / "osm_water_window_query.txt"
DATA_FILE = OUT_DIR / "osm_water_window.json"
MANIFEST = OUT_DIR / "osm_water_window_manifest.json"
ENDPOINT = "https://overpass-api.de/api/interpreter"
MIRROR = "https://overpass.kumi.systems/api/interpreter"
UA = "montes-de-oca/1.0 (water fetch)"


def window_bbox() -> tuple[float, float, float, float]:
    cfg = json.loads(CONFIG.read_text())
    o, p = cfg["origin"], cfg["projection"]
    b = cfg["bounds"]
    # El origen lon/lat del config es la esquina SW del mundo (= UTM 471500,
    # 4689000), así que los bounds absolutos hay que pasarlos a offsets
    # relativos a esa esquina antes de dividir por metrosPorGrado.
    e0, n0 = b["e"][0], b["n"][0]
    west = o["lon"] + (b["e"][0] - e0) / p["metersPerDegreeLon"]
    east = o["lon"] + (b["e"][1] - e0) / p["metersPerDegreeLon"]
    south = o["lat"] + (b["n"][0] - n0) / p["metersPerDegreeLat"]
    north = o["lat"] + (b["n"][1] - n0) / p["metersPerDegreeLat"]
    return south, west, north, east


def post_query(query: str) -> tuple[bytes, str]:
    """Envía la consulta al endpoint principal; ante 429, 504 o timeout
    reintenta UNA vez contra el mirror. Devuelve (crudo, endpoint_usado)."""
    body = urllib.parse.urlencode({"data": query}).encode()
    last_error: Exception | None = None
    for i, url in enumerate((ENDPOINT, MIRROR)):
        request = urllib.request.Request(url, data=body, headers={"User-Agent": UA})
        try:
            with urllib.request.urlopen(request, timeout=180) as response:
                return response.read(), url
        except urllib.error.HTTPError as e:
            # Solo 429/504 justifican probar el mirror; otro código es final.
            last_error = e
            print(
                f"[agua] {url} devolvió HTTP {e.code}; "
                + (
                    "probando mirror…"
                    if i == 0 and e.code in (429, 504)
                    else "sin reintento"
                ),
                file=sys.stderr,
            )
            if not (i == 0 and e.code in (429, 504)):
                raise
        except (urllib.error.URLError, TimeoutError, socket.timeout) as e:
            last_error = e
            print(
                f"[agua] {url} falló ({e}); "
                + ("probando mirror…" if i == 0 else "sin más reintentos"),
                file=sys.stderr,
            )
            if i > 0:
                raise
    raise last_error  # inalcanzable en la práctica; el for relanza arriba


def main() -> int:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    s, w, n, e = window_bbox()
    query = f"""[out:json][timeout:90];
(
  way["waterway"]({s:.6f},{w:.6f},{n:.6f},{e:.6f});
  way["natural"="water"]({s:.6f},{w:.6f},{n:.6f},{e:.6f});
  rel["natural"="water"]({s:.6f},{w:.6f},{n:.6f},{e:.6f});
);
out geom tags;
"""
    QUERY_FILE.write_text(query)
    raw, used_endpoint = post_query(query)
    payload = json.loads(raw)
    elements = payload.get("elements", [])
    kinds = {
        "reservoir": 0,
        "dam": 0,
        "river": 0,
        "stream": 0,
        "lake": 0,
        "pond": 0,
        "wastewater": 0,
    }
    for element in elements:
        tags = element.get("tags", {})
        if tags.get("water") == "reservoir":
            kinds["reservoir"] += 1
        if tags.get("water") == "wastewater":
            kinds["wastewater"] += 1
        if tags.get("water") == "lake":
            kinds["lake"] += 1
        if tags.get("water") == "pond":
            kinds["pond"] += 1
        if tags.get("waterway") == "dam":
            kinds["dam"] += 1
        if tags.get("waterway") == "river":
            kinds["river"] += 1
        if tags.get("waterway") == "stream":
            kinds["stream"] += 1
    DATA_FILE.write_text(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n"
    )
    digest = hashlib.sha256(DATA_FILE.read_bytes()).hexdigest()
    MANIFEST.write_text(
        json.dumps(
            {
                "generado_por": "scripts/water/fetch_water.py",
                "endpoint": used_endpoint,
                "bbox": {"south": s, "west": w, "north": n, "east": e},
                "sha256": digest,
                "bytes": DATA_FILE.stat().st_size,
                "elements": len(elements),
                "counts": kinds,
            },
            indent=2,
            ensure_ascii=False,
        )
        + "\n"
    )
    print(f"[agua] {len(elements)} elementos · {kinds} · sha256 {digest[:12]}")
    if kinds["reservoir"] < 1 or kinds["dam"] < 1 or kinds["river"] < 2:
        print(
            "[agua] FALLA: faltan elementos esperados (embalse, presa, ríos)",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
