#!/usr/bin/env python3
"""Descarga reproducible del MDT05 (IGN) para la ventana real de Villafranca.

Producto: Modelo Digital del Terreno de paso 5 m (PNOA-LiDAR) servido por el WCS
INSPIRE del IGN/CNIG. Licencia CC BY 4.0. No requiere registro ni credenciales.

Ventana de MUNDO (la que fija el packet y la convención de coordenadas):
    E = [471500, 477500]  (6000 m)
    N = [4689000, 4695000] (6000 m)
    EPSG:25830 (ETRS89 / UTM 30N), sin reproyectar.

Trampa del WCS 2.0 (verificada empíricamente contra `data/geo/raw/mdt05_bbox_5m.tif`):
`subset=x(min,max)` con `scale-factor`/resolución nativa devuelve `(max-min)/res`
MUESTRAS, es decir el intervalo [min, max). Para cubrir los 1201 NODOS inclusivos
del borde (necesarios para que cada tile de 1000 m tenga 201x201 nodos), se pide
la ventana extendida una celda al este y una al sur:
    x(471500, 477505)   -> 1201 muestras, nodos en 471500 + i*5, i=0..1200
    y(4688995, 4695000) -> 1201 muestras, nodos en 4695000 - j*5, j=0..1200
El nodo de la esquina SW del raster es exactamente (471500, 4695000) y el del
extremo es (477500, 4689000). El .tif queda con AREA_OR_POINT=Area y origen en el
nodo (convención "corner registration" que usa también el pipeline de referencia).

Salida:
    data/terrain/raw/<nombre>.tif
    data/terrain/raw/<nombre>.tif.sha256
    data/terrain/raw/fetch_manifest.json   (URL, SHA256, bytes, ventana, nodos)

Uso:
    .venv/bin/python scripts/terrain/fetch_dem_mdt05.py [--force]
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

import rasterio
from rasterio.crs import CRS

# --- Ventana de mundo (coordenadas del packet, NO reinterpretar) --------------
CRS_EPSG = 25830
E0 = 471500.0
N0 = 4689000.0
SIDE_M = 6000.0
SAMPLING_M = 5.0
NODES = int(SIDE_M / SAMPLING_M) + 1  # 1201 nodos inclusivos

# Ventana WCS extendida una celda al E y al S (ver docstring).
WCS_X_MIN = E0
WCS_X_MAX = E0 + NODES * SAMPLING_M          # 477505
WCS_Y_MIN = N0 - SAMPLING_M                  # 4688995
WCS_Y_MAX = N0 + SIDE_M                      # 4695000

WCS_BASE = "https://servicios.idee.es/wcs-inspire/mdt"
COVERAGE_ID = "Elevacion25830_5"
USER_AGENT = (
    "montes-de-oca-offroad/0.1 (terrain pipeline; contacto: proyecto local) "
    "Python-urllib"
)

OUT_NAME = "mdt05_villafranca_6000m_5m.tif"

PROJECT_ROOT = Path(__file__).resolve().parents[2]
RAW_DIR = PROJECT_ROOT / "data" / "terrain" / "raw"
OUT_TIF = RAW_DIR / OUT_NAME
OUT_SHA = RAW_DIR / f"{OUT_NAME}.sha256"
OUT_MANIFEST = RAW_DIR / "fetch_manifest.json"


def build_url() -> str:
    params = {
        "service": "WCS",
        "version": "2.0.0",
        "request": "GetCoverage",
        "coverageId": COVERAGE_ID,
        "format": "image/tiff",
        "subset": [
            f"x({WCS_X_MIN:.0f},{WCS_X_MAX:.0f})",
            f"y({WCS_Y_MIN:.0f},{WCS_Y_MAX:.0f})",
        ],
    }
    # subset repetido: urllib.parse no maneja listas por defecto -> urlencode con doseq
    return f"{WCS_BASE}?{urllib.parse.urlencode(params, doseq=True)}"


def sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def download(url: str, dest: Path) -> None:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    print(f"[fetch] GET {url}")
    with urllib.request.urlopen(request, timeout=180) as response:
        status = getattr(response, "status", response.getcode())
        ctype = response.headers.get("Content-Type", "")
        if status != 200:
            raise RuntimeError(f"WCS respondió HTTP {status}")
        if "tiff" not in ctype.lower():
            raise RuntimeError(
                f"WCS no devolvió TIFF (Content-Type={ctype!r}). "
                "Abortado en vez de guardar basura."
            )
        data = response.read()
    if data[:2] not in (b"II", b"MM"):
        raise RuntimeError("El cuerpo no es un TIFF válido (magic bytes)")
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(data)
    print(f"[fetch] guardado {dest} ({len(data)} bytes)")


def validate(path: Path) -> dict:
    """Valida CRS, grilla y alineación exacta con los nodos de mundo."""
    with rasterio.open(path) as ds:
        crs = ds.crs
        if crs is None or CRS.from_user_input(crs).to_epsg() != CRS_EPSG:
            raise RuntimeError(f"CRS inesperado: {crs!r} (se esperaba EPSG:{CRS_EPSG})")
        if (ds.width, ds.height) != (NODES, NODES):
            raise RuntimeError(
                f"grilla inesperada {ds.width}x{ds.height}; se esperaban {NODES}x{NODES}"
            )
        t = ds.transform
        if abs(t.a - SAMPLING_M) > 1e-9 or abs(t.e + SAMPLING_M) > 1e-9:
            raise RuntimeError(f"paso inesperado en el transform: {t}")
        if abs(t.b) > 1e-9 or abs(t.d) > 1e-9:
            raise RuntimeError(f"transform con rotación/skew inesperado: {t}")
        if abs(t.c - E0) > 1e-6 or abs(t.f - (N0 + SIDE_M)) > 1e-6:
            raise RuntimeError(
                f"origen inesperado {t.c},{t.f}; se esperaba {E0},{N0 + SIDE_M}"
            )
        arr = ds.read(1)
        nodata = ds.nodata
        info = {
            "width": ds.width,
            "height": ds.height,
            "crs": str(CRS.from_user_input(crs)),
            "dtype": str(ds.dtypes[0]),
            "nodata": None if nodata is None else float(nodata),
            "transform": list(t)[:6],
            "bounds": [ds.bounds.left, ds.bounds.bottom, ds.bounds.right, ds.bounds.top],
            "min_m": float(arr.min()),
            "max_m": float(arr.max()),
        }
    if info["nodata"] is not None:
        # Sin rellenos silenciosos: si aparece nodata, se reporta.
        print(f"[warn] el DEM declara nodata={info['nodata']}", file=sys.stderr)
    return info


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--force", action="store_true", help="reenviar la descarga aunque exista")
    args = parser.parse_args()

    url = build_url()
    if OUT_TIF.exists() and not args.force:
        print(f"[fetch] ya existe {OUT_TIF} (usar --force para re-descargar)")
    else:
        download(url, OUT_TIF)

    digest = sha256_of(OUT_TIF)
    info = validate(OUT_TIF)

    OUT_SHA.write_text(f"{digest}  {OUT_NAME}\n", encoding="utf-8")
    manifest = {
        "generador": "scripts/terrain/fetch_dem_mdt05.py",
        "fecha_utc": datetime.now(timezone.utc).isoformat(),
        "producto": "IGN/CNIG MDT05 (PNOA-LiDAR), paso 5 m",
        "licencia": "CC BY 4.0 (scne.es)",
        "coverage_id": COVERAGE_ID,
        "url_getcoverage": url,
        "user_agent": USER_AGENT,
        "ventana_mundo": {
            "crs": f"EPSG:{CRS_EPSG}",
            "e_min": E0,
            "n_min": N0,
            "lado_m": SIDE_M,
            "sampling_m": SAMPLING_M,
            "nodos": NODES,
        },
        "ventana_wcs_pedida": {
            "x": [WCS_X_MIN, WCS_X_MAX],
            "y": [WCS_Y_MIN, WCS_Y_MAX],
            "nota": "una celda extendida al E y al S por la semántica [min,max) del WCS",
        },
        "archivo": OUT_NAME,
        "sha256": digest,
        "bytes": OUT_TIF.stat().st_size,
        **info,
    }
    OUT_MANIFEST.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )

    print(f"[ok] sha256={digest}")
    print(
        f"[ok] {info['width']}x{info['height']} {info['crs']} {info['dtype']} "
        f"min={info['min_m']:.0f} max={info['max_m']:.0f} m"
    )
    print(f"[ok] manifest -> {OUT_MANIFEST}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
