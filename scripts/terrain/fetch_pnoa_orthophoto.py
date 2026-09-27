#!/usr/bin/env python3
"""Captura reproducible de la ortofoto PNOA Máxima Actualidad (IGN/CNIG).

Fuente oficial: WMS INSPIRE ``https://www.ign.es/wms-inspire/pnoa-ma``,
WMS 1.3.0, capa ``OI.OrthoimageCoverage`` (CC BY 4.0 scne.es). Los metadatos
oficiales de fecha/resolución del mosaico se consultan por centro de tesela
en la capa consultable ``OI.MosaicElement`` vía GetFeatureInfo.

Ventana de mundo (la misma del MDT y del packet):
    E = [471500, 477500]  (6000 m)
    N = [4689000, 4695000] (6000 m)
    EPSG:25830, sin reproyectar.

Se piden cuatro cuadrantes exactos de 3000 x 3000 m a 3072 x 3072 px
(~0.977 m/px), por debajo del máximo 4096 x 4096 del servicio.

Salida (reemplazo atómico; ante cualquier fallo el snapshot previo queda intacto):
    data/terrain/raw/pnoa_orthophoto/{nw,ne,sw,se}.jpg
    data/terrain/raw/pnoa_orthophoto/source_manifest.json

Uso:
    .venv/bin/python scripts/terrain/fetch_pnoa_orthophoto.py

Solo stdlib (urllib); sin dependencias nuevas.
"""
from __future__ import annotations

import hashlib
import json
import shutil
import struct
import sys
import tempfile
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path

WMS_BASE = "https://www.ign.es/wms-inspire/pnoa-ma"
WMS_VERSION = "1.3.0"
LAYER = "OI.OrthoimageCoverage"
MOSAIC_LAYER = "OI.MosaicElement"
INFO_FORMAT = "application/json"
IMAGE_FORMAT = "image/jpeg"
LICENSE = "CC BY 4.0 scne.es"
ATTRIBUTION = "Ortofoto PNOA Máxima Actualidad, IGN/CNIG"

CRS_EPSG = 25830
E_MIN, N_MIN = 471500, 4689000
E_MAX, N_MAX = 477500, 4695000
E_MID = (E_MIN + E_MAX) // 2  # 474500
N_MID = (N_MIN + N_MAX) // 2  # 4692000
QUAD_PX = 3072
QUAD_M = 3000
GFI_PX = 101
GFI_HALF_M = 500.0

QUADRANTS: dict[str, tuple[int, int, int, int]] = {
    "nw": (E_MIN, N_MID, E_MID, N_MAX),
    "ne": (E_MID, N_MID, E_MAX, N_MAX),
    "sw": (E_MIN, N_MIN, E_MID, N_MID),
    "se": (E_MID, N_MIN, E_MAX, N_MID),
}

USER_AGENT = "montes-de-oca-offroad/0.1 (terrain pipeline; contacto: proyecto local) Python-urllib"

PROJECT_ROOT = Path(__file__).resolve().parents[2]
OUT_DIR = PROJECT_ROOT / "data" / "terrain" / "raw" / "pnoa_orthophoto"


def tile_centers() -> list[tuple[int, int]]:
    """Los 36 centros de tesela de 1 km (E,N enteros)."""
    return [
        (E_MIN + 500 + 1000 * ix, N_MIN + 500 + 1000 * iy)
        for iy in range(6)
        for ix in range(6)
    ]


def build_getmap_url(bbox: tuple[int, int, int, int]) -> str:
    params = {
        "service": "WMS",
        "version": WMS_VERSION,
        "request": "GetMap",
        "layers": LAYER,
        "styles": "",
        "crs": f"EPSG:{CRS_EPSG}",
        "bbox": f"{bbox[0]},{bbox[1]},{bbox[2]},{bbox[3]}",
        "width": str(QUAD_PX),
        "height": str(QUAD_PX),
        "format": IMAGE_FORMAT,
    }
    return f"{WMS_BASE}?{urllib.parse.urlencode(params)}"


def build_getfeatureinfo_url(e: int, n: int) -> str:
    params = {
        "service": "WMS",
        "version": WMS_VERSION,
        "request": "GetFeatureInfo",
        "layers": LAYER,
        "query_layers": MOSAIC_LAYER,
        "styles": "",
        "crs": f"EPSG:{CRS_EPSG}",
        "bbox": f"{e - GFI_HALF_M:.0f},{n - GFI_HALF_M:.0f},{e + GFI_HALF_M:.0f},{n + GFI_HALF_M:.0f}",
        "width": str(GFI_PX),
        "height": str(GFI_PX),
        "i": str(GFI_PX // 2),
        "j": str(GFI_PX // 2),
        "info_format": INFO_FORMAT,
    }
    return f"{WMS_BASE}?{urllib.parse.urlencode(params)}"


def http_get(url: str) -> tuple[str, bytes]:
    """GET real. Los tests la sustituyen por un doble programable."""
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=180) as response:
        status = getattr(response, "status", response.getcode())
        if status != 200:
            raise RuntimeError(f"WMS respondió HTTP {status} para {url[:120]}")
        return (response.headers.get("Content-Type", ""), response.read())


def check_capabilities() -> dict:
    """Valida GetCapabilities: capas exigidas y límite 4096."""
    url = f"{WMS_BASE}?{urllib.parse.urlencode({'service': 'WMS', 'version': WMS_VERSION, 'request': 'GetCapabilities'})}"
    ctype, payload = http_get(url)
    try:
        root = ET.fromstring(payload)
    except ET.ParseError as exc:
        raise RuntimeError(f"GetCapabilities no es XML válido: {exc}") from exc
    ns = {"w": "http://www.opengis.net/wms"}
    names: dict[str, str | None] = {}
    for layer in root.iter("{http://www.opengis.net/wms}Layer"):
        name_el = layer.find("w:Name", ns)
        if name_el is not None and name_el.text:
            names[name_el.text.strip()] = layer.get("queryable")
    if LAYER not in names:
        raise RuntimeError(f"GetCapabilities no anuncia la capa {LAYER}")
    if MOSAIC_LAYER not in names:
        raise RuntimeError(f"GetCapabilities no anuncia la capa {MOSAIC_LAYER}")
    if names[MOSAIC_LAYER] != "1":
        raise RuntimeError(f"la capa {MOSAIC_LAYER} no es consultable (queryable!=1)")

    def _int(tag: str) -> int | None:
        el = root.find(f".//{{http://www.opengis.net/wms}}{tag}")
        if el is not None and el.text and el.text.strip().isdigit():
            return int(el.text.strip())
        return None

    max_w, max_h = _int("MaxWidth"), _int("MaxHeight")
    if max_w is not None and max_w < QUAD_PX:
        raise RuntimeError(f"MaxWidth={max_w} menor que {QUAD_PX}")
    if max_h is not None and max_h < QUAD_PX:
        raise RuntimeError(f"MaxHeight={max_h} menor que {QUAD_PX}")
    return {"max_width": max_w, "max_height": max_h, "capabilities_url": url}


def jpeg_dimensions(data: bytes) -> tuple[int, int]:
    """Dimensiones declaradas en el SOF del JPEG. Lanza RuntimeError si no es JPEG."""
    if len(data) < 4 or data[0] != 0xFF or data[1] != 0xD8:
        raise RuntimeError("el cuerpo no es un JPEG válido (falta SOI FFD8)")
    pos = 2
    n = len(data)
    while pos + 4 <= n:
        if data[pos] != 0xFF:
            raise RuntimeError("JPEG corrupto: marcador esperado")
        marker = data[pos + 1]
        pos += 2
        if marker == 0xD8 or (0xD0 <= marker <= 0xD9):
            continue
        if pos + 2 > n:
            break
        seg_len = struct.unpack(">H", data[pos : pos + 2])[0]
        if seg_len < 2 or pos + seg_len > n:
            raise RuntimeError("JPEG corrupto: segmento truncado")
        if marker in (0xC0, 0xC1, 0xC2, 0xC3):
            if seg_len < 7:
                raise RuntimeError("JPEG corrupto: SOF truncado")
            height = struct.unpack(">H", data[pos + 3 : pos + 5])[0]
            width = struct.unpack(">H", data[pos + 5 : pos + 7])[0]
            return (width, height)
        pos += seg_len
    raise RuntimeError("JPEG sin cabecera SOF: imagen incompleta o corrupta")


def validate_image(data: bytes, ctype: str, url: str) -> None:
    if "image/jpeg" not in ctype.lower():
        raise RuntimeError(
            f"WMS no devolvió imagen (Content-Type={ctype!r}) para {url[:120]}. Abortado en vez de guardar basura."
        )
    width, height = jpeg_dimensions(data)
    if (width, height) != (QUAD_PX, QUAD_PX):
        raise RuntimeError(f"dimensiones JPEG {width}x{height}; se esperaban {QUAD_PX}x{QUAD_PX}")
    if data[-2:] != b"\xff\xd9":
        raise RuntimeError("JPEG truncado: falta el marcador EOI final")


def parse_gfi(payload: bytes, e: int, n: int) -> tuple[str, str]:
    try:
        doc = json.loads(payload.decode("utf-8"))
    except (ValueError, UnicodeDecodeError) as exc:
        raise RuntimeError(f"GetFeatureInfo no es JSON válido en ({e},{n}): {exc}") from exc
    features = doc.get("features") if isinstance(doc, dict) else None
    if not features:
        raise RuntimeError(f"GetFeatureInfo sin features (metadato oficial ausente) en ({e},{n})")
    props = features[0].get("properties", {}) if isinstance(features[0], dict) else {}
    date = props.get("Fecha", props.get("FECHA", ""))
    resolution = props.get("Resolucion", props.get("RESOLUCION", ""))
    date, resolution = str(date).strip(), str(resolution).strip()
    if not date or not resolution:
        raise RuntimeError(
            f"metadato oficial fecha/resolución ausente en ({e},{n}): {props!r}"
        )
    return (date, resolution)


def capture(out_dir: Path = OUT_DIR) -> dict:
    """Descarga, valida y reemplaza atómicamente el snapshot + manifiesto."""
    out_dir = Path(out_dir)
    caps = check_capabilities()

    staged_images: dict[str, tuple[bytes, str, str]] = {}
    for name, bbox in QUADRANTS.items():
        url = build_getmap_url(bbox)
        ctype, data = http_get(url)
        validate_image(data, ctype, url)
        staged_images[name] = (data, ctype, url)

    centers_meta: list[dict] = []
    for (e, n) in tile_centers():
        url = build_getfeatureinfo_url(e, n)
        ctype, payload = http_get(url)
        date, resolution = parse_gfi(payload, e, n)
        centers_meta.append({"e": e, "n": n, "date": date, "resolution_m": resolution})

    manifest = {
        "generator": "scripts/terrain/fetch_pnoa_orthophoto.py",
        "fetched_utc": datetime.now(timezone.utc).isoformat(),
        "service": WMS_BASE,
        "wms_version": WMS_VERSION,
        "layer": LAYER,
        "mosaic_layer": MOSAIC_LAYER,
        "license": LICENSE,
        "attribution": ATTRIBUTION,
        "crs": f"EPSG:{CRS_EPSG}",
        "bounds": {"e_min": E_MIN, "n_min": N_MIN, "e_max": E_MAX, "n_max": N_MAX},
        "quadrants": {},
        "tile_centers": centers_meta,
        "capabilities": caps,
    }
    quadrants = manifest["quadrants"]
    assert isinstance(quadrants, dict)
    for name, bbox in QUADRANTS.items():
        data, ctype, url = staged_images[name]
        quadrants[name] = {
            "bbox": list(bbox),
            "crs": f"EPSG:{CRS_EPSG}",
            "width_px": QUAD_PX,
            "height_px": QUAD_PX,
            "pixel_size_m": QUAD_M / QUAD_PX,
            "request_url": url,
            "response_content_type": ctype,
            "sha256": hashlib.sha256(data).hexdigest(),
            "bytes": len(data),
            "file": f"{name}.jpg",
        }

    # Publicación atómica a nivel de directorio: staging completo validado,
    # luego swap out_dir <-> staging con rollback si falla el commit.
    parent = out_dir.parent
    parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix="pnoa-stage-", dir=str(parent)))
    try:
        for name, (data, _ctype, _url) in staged_images.items():
            (staging / f"{name}.jpg").write_bytes(data)
        manifest_text = json.dumps(manifest, ensure_ascii=False, indent=2) + "\n"
        (staging / "source_manifest.json").write_text(manifest_text, encoding="utf-8")
        if not out_dir.exists() and not out_dir.is_symlink():
            staging.replace(out_dir)
        else:
            backup_holder = Path(tempfile.mkdtemp(prefix="pnoa-backup-", dir=str(parent)))
            backup_holder.rmdir()
            backup = backup_holder
            out_dir.replace(backup)
            try:
                staging.replace(out_dir)
            except Exception:
                if out_dir.is_symlink() or out_dir.exists():
                    if out_dir.is_dir() and not out_dir.is_symlink():
                        shutil.rmtree(out_dir)
                    else:
                        out_dir.unlink()
                backup.replace(out_dir)
                raise
            shutil.rmtree(backup, ignore_errors=True)
    finally:
        shutil.rmtree(staging, ignore_errors=True)
    return manifest


def main() -> int:
    manifest = capture()
    for name, q in manifest["quadrants"].items():
        print(f"[ok] {name}.jpg {q['bytes']} bytes sha256={q['sha256']}")
    dates = sorted({c["date"] for c in manifest["tile_centers"]})
    resols = sorted({c["resolution_m"] for c in manifest["tile_centers"]})
    print(f"[ok] centros: {len(manifest['tile_centers'])} fechas={dates} resoluciones_m={resols}")
    print(f"[ok] manifest -> {OUT_DIR / 'source_manifest.json'}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except RuntimeError as exc:
        print(f"[error] {exc}", file=sys.stderr)
        raise SystemExit(1)
