#!/usr/bin/env python3
"""Descarga la red vial OSM de la ventana jugable desde Overpass.

Ventana fija del proyecto (EPSG:25830, metros):
    E = [471500, 477500]   N = [4689000, 4695000]   -> 6000 x 6000 m
Origen del mundo = esquina SUDOESTE:
    worldX = E - 471500   worldZ = N - 4689000

Salida:
    data/roads/raw/osm_highways_window.json   respuesta cruda de Overpass
    data/roads/raw/overpass_query.txt         la consulta exacta (reproducible)
    data/roads/raw/overpass_manifest.json     URL + SHA256 + bytes + timestamps

Notas de método:
  * El bbox de consulta NO es el rectángulo "SW/NE" de las esquinas del
    rectángulo UTM: por convergencia de UTM 30N, la ventana en WGS84 tiene
    aristas curvas. Se calcula el envolvente muestreando los 4 bordes y se
    le suma un buffer de ~0.0015 deg (~165 m de latitud, ~123 m de longitud)
    para que ninguna way que cruce el borde quede fuera de la consulta.
  * Overpass devuelve la GEOMETRIA COMPLETA de las ways que intersectan el
    bbox, asi que el buffer es solo una red de seguridad; el recorte real lo
    hace build_roads.py contra la ventana exacta.
  * Overpass exige User-Agent (con uno generico devuelve 406) y devuelve 504
    con frecuencia: se reintenta con backoff.
  * Este script SOLO descarga. No clasifica ni proyecta.

Uso:
    .venv/bin/python scripts/roads/fetch_osm_roads.py [--force]
"""
from __future__ import annotations

import argparse
import hashlib
import json
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

from pyproj import Transformer

ROOT = Path(__file__).resolve().parents[2]
OUT_DIR = ROOT / "data" / "roads" / "raw"
DEFAULT_NAME = "osm_highways_window.json"

# --- Ventana jugable (EPSG:25830) ------------------------------------------
E_MIN, E_MAX = 471500.0, 477500.0
N_MIN, N_MAX = 4689000.0, 4695000.0
BUFFER_DEG = 0.0015  # red de seguridad alrededor del envolvente WGS84
DEFAULT_BUFFER_DEG = BUFFER_DEG

# --- Overpass ---------------------------------------------------------------
ENDPOINT = "https://overpass-api.de/api/interpreter"
# User-Agent obligatorio: overpass-api.de responde 406 con UA generico.
USER_AGENT = "MontesDeOcaOffroad-RoadsBot/1.0 (open-world driving game data; offline research)"
MAX_ATTEMPTS = 6
RETRY_SLEEP_S = 8
REQUEST_TIMEOUT_S = 300


def wgs84_envelope(buffer_deg: float) -> tuple[float, float, float, float]:
    """Envolvente WGS84 (S, W, N, E) que CONTIENE la ventana UTM + buffer.

    Muestrea los 4 bordes del rectangulo UTM cada 250 m. Usar solo las dos
    esquinas dadas (SW/NE) dejaria fuera un filete en el borde oeste (~25 m)
    y este (~19 m) por la convergencia de UTM 30N.
    """
    tr = Transformer.from_crs("EPSG:25830", "EPSG:4326", always_xy=True)
    corners = [
        (E_MIN, N_MIN),
        (E_MAX, N_MIN),
        (E_MAX, N_MAX),
        (E_MIN, N_MAX),
    ]
    lons: list[float] = []
    lats: list[float] = []
    for i in range(4):
        a, b = corners[i], corners[(i + 1) % 4]
        for k in range(25):
            f = k / 25.0
            lon, lat = tr.transform(a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f)
            lons.append(lon)
            lats.append(lat)
    lon_min, lon_max = min(lons), max(lons)
    lat_min, lat_max = min(lats), max(lats)
    return (
        lat_min - buffer_deg,
        lon_min - buffer_deg,
        lat_max + buffer_deg,
        lon_max + buffer_deg,
    )


def build_query(bbox: tuple[float, float, float, float], timeout_s: int = 180) -> str:
    s, w, n, e = bbox
    # `out tags geom qt` -> tags crudos + geometria de cada node de la way.
    # SIN bbox en `out geom`: con bbox, Overpass recorta la geometria (deja el
    # primer/ultimo punto fuera del bbox) y ahi si perderiamos tramos.
    # Sin node ids: la conectividad se reconstruye en build_roads.py por
    # igualdad exacta de coordenadas (Overpass serializa el mismo node con el
    # mismo lat/lon en todas las ways que lo comparten).
    return (
        f"[out:json][timeout:{timeout_s}];\n"
        f'way["highway"]({s:.6f},{w:.6f},{n:.6f},{e:.6f});\n'
        "out tags geom qt;\n"
    )


def post_overpass(query: str) -> tuple[bytes, dict]:
    """POST con reintentos. Devuelve (body, info_de_intento)."""
    data = urllib.parse.urlencode({"data": query}).encode("utf-8")
    last_info: dict = {}
    for attempt in range(1, MAX_ATTEMPTS + 1):
        req = urllib.request.Request(
            ENDPOINT,
            data=data,
            headers={
                "User-Agent": USER_AGENT,
                "Content-Type": "application/x-www-form-urlencoded",
                "Accept": "application/json",
            },
            method="POST",
        )
        started = datetime.now(timezone.utc).isoformat(timespec="seconds")
        try:
            with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT_S) as resp:
                body = resp.read()
                code = resp.status
        except urllib.error.HTTPError as exc:  # 406 / 429 / 504 / 503...
            body = exc.read() if exc.fp else b""
            code = exc.code
            last_info = {"attempt": attempt, "http": code, "requested_at": started}
            print(f"  intento {attempt}/{MAX_ATTEMPTS} -> HTTP {code}, reintento en {RETRY_SLEEP_S}s", flush=True)
            time.sleep(RETRY_SLEEP_S)
            continue
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            last_info = {"attempt": attempt, "http": 0, "error": str(exc), "requested_at": started}
            print(f"  intento {attempt}/{MAX_ATTEMPTS} -> {exc}, reintento en {RETRY_SLEEP_S}s", flush=True)
            time.sleep(RETRY_SLEEP_S)
            continue

        last_info = {"attempt": attempt, "http": code, "requested_at": started}
        if code != 200:
            print(f"  intento {attempt}/{MAX_ATTEMPTS} -> HTTP {code}, reintento en {RETRY_SLEEP_S}s", flush=True)
            time.sleep(RETRY_SLEEP_S)
            continue
        if not body.lstrip().startswith(b"{"):
            print(f"  intento {attempt}/{MAX_ATTEMPTS} -> cuerpo no-JSON, reintento en {RETRY_SLEEP_S}s", flush=True)
            time.sleep(RETRY_SLEEP_S)
            continue
        return body, last_info
    raise SystemExit(f"FALLO: Overpass no respondio 200 en {MAX_ATTEMPTS} intentos. Ultimo: {last_info}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--force", action="store_true", help="vuelve a descargar aunque ya exista")
    parser.add_argument(
        "--buffer-deg",
        type=float,
        default=DEFAULT_BUFFER_DEG,
        help="buffer alrededor del envolvente WGS84 de la ventana (default %(default)s)",
    )
    parser.add_argument(
        "--name",
        default=DEFAULT_NAME,
        help="nombre del archivo de salida en data/roads/raw/ (default %(default)s)",
    )
    parser.add_argument("--timeout", type=int, default=180, help="timeout Overpass en segundos")
    args = parser.parse_args()

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    raw_path = OUT_DIR / args.name
    query_path = OUT_DIR / f"{Path(args.name).stem}_query.txt"
    manifest_path = OUT_DIR / f"{Path(args.name).stem}_manifest.json"
    if raw_path.exists() and not args.force:
        print(f"Ya existe {raw_path.relative_to(ROOT)}; use --force para volver a bajar.")
        return

    bbox = wgs84_envelope(args.buffer_deg)
    query = build_query(bbox, timeout_s=args.timeout)
    query_path.write_text(query, encoding="utf-8")

    s, w, n, e = bbox
    print(f"BBox consulta (S,W,N,E) = {s:.6f},{w:.6f},{n:.6f},{e:.6f}  (buffer {args.buffer_deg} deg)")
    print(f"Endpoint: {ENDPOINT}")
    print("Descargando...", flush=True)

    body, info = post_overpass(query)
    payload = json.loads(body)

    remark = payload.get("remark")
    if remark:
        raise SystemExit(f"FALLO: Overpass devolvio un runtime error: {remark}")

    elements = payload.get("elements", [])
    kinds: dict[str, int] = {}
    for el in elements:
        kinds[el.get("type", "?")] = kinds.get(el.get("type", "?"), 0) + 1
    if not elements:
        raise SystemExit("FALLO: la consulta devolvio 0 elementos.")

    sha = hashlib.sha256(body).hexdigest()
    raw_path.write_bytes(body)

    manifest = {
        "endpoint": ENDPOINT,
        "url": ENDPOINT,
        "method": "POST application/x-www-form-urlencoded",
        "user_agent": USER_AGENT,
        "query_file": str(query_path.relative_to(ROOT)),
        "query": query,
        "bbox_wgs84_s_w_n_e": [round(v, 6) for v in bbox],
        "buffer_deg": args.buffer_deg,
        "window_utm30n": {"e": [E_MIN, E_MAX], "n": [N_MIN, N_MAX]},
        "requested_at_utc": info.get("requested_at"),
        "http_status": info.get("http"),
        "attempts": info.get("attempt"),
        "overpass_timestamp_osm_base": payload.get("osm3s", {}).get("timestamp_osm_base"),
        "overpass_generator": payload.get("generator"),
        "fetched_at_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "file": str(raw_path.relative_to(ROOT)),
        "bytes": len(body),
        "sha256": sha,
        "elements": {"total": len(elements), "by_type": kinds},
        "license": "ODbL-1.0 (OpenStreetMap contributors)",
        "remark": remark,
    }
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"HTTP {manifest['http_status']} en {manifest['attempts']} intento(s)")
    print(f"osm3s.timestamp_osm_base = {manifest['overpass_timestamp_osm_base']}")
    print(f"elementos = {len(elements)} {kinds}")
    print(f"bytes = {len(body)}  sha256 = {sha}")
    print(f"-> {raw_path.relative_to(ROOT)}")
    print(f"-> {manifest_path.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
