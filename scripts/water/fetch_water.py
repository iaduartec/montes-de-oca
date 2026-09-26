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
RING_RELATION_ID = 18149353  # Embalse de Alba (verificado en OSM)
RING_QUERY = f"[out:json][timeout:60]; rel({RING_RELATION_ID}); >; out geom;"
RING_FILE = OUT_DIR / "osm_reservoir_alba_ring.json"
RING_MANIFEST = OUT_DIR / "osm_reservoir_alba_ring_manifest.json"
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


def canonicalize_lonlat(ring: list[tuple[float, float]]) -> list[tuple[float, float]]:
    """Orden canónico: sin repetición del cierre y rotado al mínimo (lon, lat).

    Misma regla que `build_water.py` (allí sobre metros de mundo; la
    proyección es lineal con factores positivos, así que el mínimo
    lexicográfico es el mismo punto en ambas representaciones).
    """
    pts = [(float(lon), float(lat)) for lon, lat in ring]
    if len(pts) > 1 and pts[0] == pts[-1]:
        pts.pop()
    if len(pts) < 3:
        raise ValueError(f"anillo degenerado: {len(pts)} vértices")
    i = min(range(len(pts)), key=lambda k: (pts[k][0], pts[k][1]))
    return pts[i:] + pts[:i]


def assemble_ring(ways: list[dict]) -> tuple[list[tuple[float, float]], list[int], int]:
    """Une los ways de la relation por extremos exactos en un anillo cerrado.

    Devuelve (anillo_sin_cierre, ids_de_miembros, nodos_geom_totales).
    Falla si no sale un único anillo cerrado con todos los ways.
    """
    seqs = [[(g["lon"], g["lat"]) for g in w.get("geometry", [])] for w in ways]
    if any(len(s) < 2 for s in seqs):
        raise ValueError("un way miembro viene sin geometría")
    ring = list(seqs[0])
    used = {0}
    for _ in range(len(seqs) - 1):
        head, tail = ring[0], ring[-1]
        found = None
        for i, s in enumerate(seqs):
            if i in used:
                continue
            if s[0] == tail:
                found = (i, False, True)
                break
            if s[-1] == tail:
                found = (i, True, True)
                break
            if s[-1] == head:
                found = (i, False, False)
                break
            if s[0] == head:
                found = (i, True, False)
                break
        if found is None:
            raise ValueError(
                f"los ways no encadenan en un anillo único ({len(used)}/{len(seqs)} unidos)"
            )
        i, rev, at_tail = found
        s = list(reversed(seqs[i])) if rev else list(seqs[i])
        used.add(i)
        ring = ring + s[1:] if at_tail else s[:-1] + ring
    if ring[0] != ring[-1]:
        raise ValueError("el anillo ensamblado no cierra")
    if len(ring) - 1 < 3:
        raise ValueError("anillo degenerado tras ensamblar")
    return ring[:-1], [w.get("id") for w in ways], sum(len(s) for s in seqs)


def fetch_ring() -> int:
    """Descarga la relation del embalse y versiona su anillo como crudo propio."""
    raw, used_endpoint = post_query(RING_QUERY)
    payload = json.loads(raw)
    ways = [e for e in payload.get("elements", []) if e.get("type") == "way"]
    if not ways:
        print("[agua] FALLA: la relation no trajo ways miembro", file=sys.stderr)
        return 1
    ring, members, nodes = assemble_ring(ways)
    ring = canonicalize_lonlat(ring)
    RING_FILE.write_text(
        json.dumps(
            {
                "relation": RING_RELATION_ID,
                "ring": [[lon, lat] for lon, lat in ring],
                "members": members,
            },
            ensure_ascii=False,
            separators=(",", ":"),
        )
        + "\n"
    )
    digest = hashlib.sha256(RING_FILE.read_bytes()).hexdigest()
    RING_MANIFEST.write_text(
        json.dumps(
            {
                "generado_por": "scripts/water/fetch_water.py",
                "source": used_endpoint,
                "query": RING_QUERY,
                "relation": RING_RELATION_ID,
                "sha256": digest,
                "bytes": RING_FILE.stat().st_size,
                "members": len(members),
                "nodes": nodes,
            },
            indent=2,
            ensure_ascii=False,
        )
        + "\n"
    )
    print(
        f"[agua] anillo relation {RING_RELATION_ID}: {len(members)} ways, "
        f"{nodes} nodos, {len(ring)} vértices · sha256 {digest[:12]}"
    )
    return 0


def main() -> int:
    if "--ring-only" in sys.argv:
        return fetch_ring()
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
    return fetch_ring()


if __name__ == "__main__":
    raise SystemExit(main())
