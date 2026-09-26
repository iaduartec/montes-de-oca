#!/usr/bin/env python3
"""Fetch the IGN/CNIG normalized building-height raster for Villafranca.

Requires Pillow and NumPy for reading the WCS GeoTIFF and writing the compact
row-major Int16 grid consumed by the browser. Both the original raster and the
runtime grid are kept as separate IGN/CNIG data products.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
import urllib.parse
import urllib.request

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
RAW_DIR = ROOT / "data" / "gameplay" / "raw"
RAW_FILE = RAW_DIR / "ign_mdsn_e025_villafranca_2_5m.tif"
MANIFEST_FILE = RAW_DIR / "ign_mdsn_e025_villafranca_manifest.json"
PUBLIC_DIR = ROOT / "public" / "village"
GRID_FILE = PUBLIC_DIR / "building_height_grid.json"
VALUES_FILE = PUBLIC_DIR / "ign_mdsn_e025_villafranca_2_5m.bin"

WCS_BASE = "https://wcs-mds.idee.es/mds"
WIDTH = 300
HEIGHT = 548
PIXEL_SIZE_M = 2.5
TOP_LEFT_E = 474390.0
TOP_LEFT_N = 4693560.0


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def build_url() -> str:
    params = {
        "service": "WCS",
        "version": "2.0.1",
        "request": "GetCoverage",
        "coverageId": "mdsn_e025",
        "format": "image/tiff",
        "subset": ["x(474390,475140)", "y(4692190,4693560)"],
    }
    return f"{WCS_BASE}?{urllib.parse.urlencode(params, doseq=True)}"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--force", action="store_true", help="re-fetch the WCS raster")
    args = parser.parse_args()

    RAW_DIR.mkdir(parents=True, exist_ok=True)
    PUBLIC_DIR.mkdir(parents=True, exist_ok=True)
    url = build_url()
    fetched_at = datetime.now(timezone.utc).isoformat()
    if RAW_FILE.exists() and not args.force:
        print(f"[ign-mdsn] usando {RAW_FILE.relative_to(ROOT)}")
    else:
        request = urllib.request.Request(
            url,
            headers={"User-Agent": "MontesDeOcaOffroad/0.1 (IGN PNOA-LiDAR data pipeline)"},
        )
        with urllib.request.urlopen(request, timeout=120) as response:
            content_type = response.headers.get("Content-Type", "")
            payload = response.read()
        if "tiff" not in content_type.lower() or payload[:4] not in (b"II*\x00", b"MM\x00*"):
            raise RuntimeError(f"WCS devolvió una respuesta no TIFF: {content_type!r}")
        RAW_FILE.write_bytes(payload)

    image = Image.open(RAW_FILE)
    scale = image.tag_v2.get(33550)
    tiepoint = image.tag_v2.get(33922)
    sample_format = image.tag_v2.get(339)
    if image.size != (WIDTH, HEIGHT):
        raise RuntimeError(f"grilla inesperada {image.size}, esperada {(WIDTH, HEIGHT)}")
    if scale is None or tuple(scale[:2]) != (PIXEL_SIZE_M, PIXEL_SIZE_M):
        raise RuntimeError(f"resolución GeoTIFF inesperada: {scale}")
    if tiepoint is None or tuple(tiepoint[3:5]) != (TOP_LEFT_E, TOP_LEFT_N):
        raise RuntimeError(f"origen GeoTIFF inesperado: {tiepoint}")
    if sample_format != (2,) or image.tag_v2.get(258) != (16,):
        raise RuntimeError("se esperaba raster de enteros con signo de 16 bits")

    values = np.asarray(image, dtype="<i2")
    if values.shape != (HEIGHT, WIDTH) or int(values.max()) > 60:
        raise RuntimeError("valores de altura o forma de matriz fuera del rango esperado")
    VALUES_FILE.write_bytes(values.tobytes(order="C"))

    manifest = {
        "product": "Modelo Digital de Superficies normalizado de Edificios (MDSnE 2,5 m), PNOA-LiDAR 1ª cobertura",
        "provider": "Instituto Geográfico Nacional / Centro Nacional de Información Geográfica (IGN/CNIG)",
        "license": "CC BY 4.0",
        "source_url": url,
        "coverage_id": "mdsn_e025",
        "fetched_at_utc": fetched_at,
        "crs": "EPSG:25830",
        "raster": {
            "width": WIDTH,
            "height": HEIGHT,
            "pixel_size_m": PIXEL_SIZE_M,
            "top_left_easting_m": TOP_LEFT_E,
            "top_left_northing_m": TOP_LEFT_N,
            "pixel_registration": "area; samples taken at pixel centers",
            "sample_format": "signed int16, little-endian",
            "zero_is": "no classified building height",
        },
        "source_file": RAW_FILE.relative_to(ROOT).as_posix(),
        "source_bytes": RAW_FILE.stat().st_size,
        "source_sha256": sha256(RAW_FILE),
        "runtime_file": VALUES_FILE.relative_to(ROOT).as_posix(),
        "runtime_bytes": VALUES_FILE.stat().st_size,
        "runtime_sha256": sha256(VALUES_FILE),
        "adaptations": "WCS crop and uncompressed GeoTIFF converted to row-major Int16 samples; meter values preserved. This IGN-only grid contains no OSM footprints or attributes.",
    }
    MANIFEST_FILE.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")

    public_meta = {
        "schemaVersion": 1,
        "license": "CC BY 4.0 (IGN/CNIG)",
        "provider": manifest["provider"],
        "product": manifest["product"],
        "sourceUrl": url,
        "sourceSha256": manifest["source_sha256"],
        "sourceFetchedAtUtc": fetched_at,
        "crs": "EPSG:25830",
        "grid": manifest["raster"],
        "valuesFile": "ign_mdsn_e025_villafranca_2_5m.bin",
        "valuesSha256": manifest["runtime_sha256"],
        "noBuildingValue": 0,
        "valueUnits": "m above local terrain; normalized building-class height from PNOA-LiDAR first coverage",
    }
    GRID_FILE.write_text(json.dumps(public_meta, indent=2) + "\n", encoding="utf-8")
    print(
        f"[ign-mdsn] {WIDTH}x{HEIGHT} @ {PIXEL_SIZE_M:g} m; "
        f"{int((values > 0).sum())} positive cells; "
        f"TIFF sha256={manifest['source_sha256']}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
