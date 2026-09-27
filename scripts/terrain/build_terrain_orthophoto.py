#!/usr/bin/env python3
"""Deterministic north-up PNOA atlas builder (Task 2).

Reads only the pinned Task 1 snapshot
``data/terrain/raw/pnoa_orthophoto/{nw,ne,sw,se}.jpg`` plus
``source_manifest.json``. No network access (no sockets; stdlib + Pillow only).

Atlas geometry (EPSG:25830, north-up, row 0 = north edge N=4695000):
    NW (E471500..474500, N4692000..4695000) -> top-left
    NE (E474500..477500, N4692000..4695000) -> top-right
    SW (E471500..474500, N4689000..4692000) -> bottom-left
    SE (E474500..477500, N4689000..4692000) -> bottom-right

Colour: PNOA pixels are preserved as-is; the only conversion is the
input profile decode to sRGB ``RGB`` (``Image.convert``), no
stylization, filtering, contrast or palette changes.

Encoding: deterministic WebP (fixed quality/method, no metadata) at
``WEBP_QUALITY``/``WEBP_METHOD``; current setting yields ~6-8 MiB,
within the 35 MiB file budget. Decoded RGBA + full mipmap chain for
6144x6144 is ~192 MiB, within the 200 MiB budget.

Usage:
    .venv/bin/python scripts/terrain/build_terrain_orthophoto.py
    .venv/bin/python scripts/terrain/build_terrain_orthophoto.py --check
``--check`` re-derives to a temp file and compares exact bytes/SHA-256
against the public manifest without touching outputs or the network.
"""
from __future__ import annotations

import hashlib
import json
import sys
import tempfile
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[2]
SOURCE_DIR = PROJECT_ROOT / "data" / "terrain" / "raw" / "pnoa_orthophoto"
PUBLIC_DIR = PROJECT_ROOT / "public" / "terrain"
WEBP_PATH = PUBLIC_DIR / "orthophoto.webp"
MANIFEST_PATH = PUBLIC_DIR / "orthophoto.json"

CRS = "EPSG:25830"
E_MIN, N_MIN = 471500, 4689000
E_MAX, N_MAX = 477500, 4695000
ATLAS_PX = 6144
HALF_PX = ATLAS_PX // 2
QUAD_PX = 3072
ATLAS_URL = "/terrain/orthophoto.webp"
MIME_WEBP = "image/webp"
SCHEMA_VERSION = 1

# Fixed encoder settings: deterministic output for identical inputs.
WEBP_QUALITY = 82
WEBP_METHOD = 4

FILE_BUDGET_BYTES = 35 * 1024 * 1024
DECODED_BUDGET_BYTES = 200 * 1024 * 1024

QUADRANT_ORDER = ("nw", "ne", "sw", "se")


def pillow_version() -> str:
    from PIL import Image  # noqa: F401

    import PIL

    return PIL.__version__


def load_source_manifest() -> dict:
    path = SOURCE_DIR / "source_manifest.json"
    if not path.exists():
        raise RuntimeError(f"falta el manifiesto de Task 1: {path}")
    return json.loads(path.read_text(encoding="utf-8"))


def load_quadrant(name: str):
    """Load one pinned quadrant; validate hash + dimensions. No network."""
    from PIL import Image

    src_manifest = load_source_manifest()
    try:
        entry = src_manifest["quadrants"][name]
    except KeyError as exc:
        raise RuntimeError(f"manifiesto Task 1 sin cuadrante {name!r}") from exc
    path = SOURCE_DIR / f"{name}.jpg"
    if not path.exists():
        raise RuntimeError(f"falta la captura fijada: {path}")
    data = path.read_bytes()
    digest = hashlib.sha256(data).hexdigest()
    if digest != entry["sha256"]:
        raise RuntimeError(f"hash de {name}.jpg no coincide con source_manifest.json")
    if len(data) != entry["bytes"]:
        raise RuntimeError(f"bytes de {name}.jpg no coinciden con source_manifest.json")
    img = Image.open(path)
    img.load()
    if img.size != (QUAD_PX, QUAD_PX):
        raise RuntimeError(f"{name}.jpg mide {img.size}; se esperaban {(QUAD_PX, QUAD_PX)}")
    return img


def to_srgb(img):
    """Input profile conversion only: decode to sRGB RGB, no stylization."""
    if img.mode == "RGB":
        return img
    return img.convert("RGB")


def assemble_atlas(nw, ne, sw, se):
    """Paste quadrants north-up onto the 6144 canvas. Resizes only if needed."""
    from PIL import Image

    parts = {"nw": nw, "ne": ne, "sw": sw, "se": se}
    normed = {}
    for name, img in parts.items():
        rgb = to_srgb(img)
        if rgb.size != (HALF_PX, HALF_PX):
            rgb = rgb.resize((HALF_PX, HALF_PX), Image.BILINEAR)
        normed[name] = rgb
    atlas = Image.new("RGB", (ATLAS_PX, ATLAS_PX))
    atlas.paste(normed["nw"], (0, 0))
    atlas.paste(normed["ne"], (HALF_PX, 0))
    atlas.paste(normed["sw"], (0, HALF_PX))
    atlas.paste(normed["se"], (HALF_PX, HALF_PX))
    return atlas


def encode_webp(atlas) -> bytes:
    """Deterministic WebP encode: fixed quality/method, no ICC/EXIF/XMP."""
    import io

    buf = io.BytesIO()
    atlas.save(
        buf,
        format="WEBP",
        quality=WEBP_QUALITY,
        method=WEBP_METHOD,
        lossless=False,
        icc_profile=None,
    )
    return buf.getvalue()


def derive_atlas_bytes() -> bytes:
    """Full offline derivation: load pinned quadrants -> assemble -> encode."""
    quads = {name: load_quadrant(name) for name in QUADRANT_ORDER}
    atlas = assemble_atlas(quads["nw"], quads["ne"], quads["sw"], quads["se"])
    return encode_webp(atlas)


def decoded_budgets(width: int, height: int) -> dict:
    decoded = width * height * 4
    factor = sum((1 / 4) ** level for level in range(12))
    with_mips = int(decoded * factor)
    return {
        "decodedRgbaBytes": decoded,
        "decodedRgbaPlusMipsBytes": with_mips,
        "decodedRgbaPlusMipsMiB": round(with_mips / (1024 * 1024), 2),
    }


def build_manifest(webp_bytes: bytes) -> dict:
    src_manifest = load_source_manifest()
    src_bytes = (SOURCE_DIR / "source_manifest.json").read_bytes()
    centers = src_manifest.get("tile_centers", [])
    dates = sorted({str(c.get("date", "")).strip() for c in centers if str(c.get("date", "")).strip()})
    resolutions = sorted(
        {str(c.get("resolution_m", "")).strip() for c in centers if str(c.get("resolution_m", "")).strip()}
    )
    budgets = decoded_budgets(ATLAS_PX, ATLAS_PX)
    manifest = {
        "schemaVersion": SCHEMA_VERSION,
        "generator": "scripts/terrain/build_terrain_orthophoto.py",
        "pillowVersion": pillow_version(),
        "asset": {
            "url": ATLAS_URL,
            "mimeType": MIME_WEBP,
            "width": ATLAS_PX,
            "height": ATLAS_PX,
            "bytes": len(webp_bytes),
            "sha256": hashlib.sha256(webp_bytes).hexdigest(),
        },
        "coverage": {
            "crs": CRS,
            "eMin": E_MIN,
            "eMax": E_MAX,
            "nMin": N_MIN,
            "nMax": N_MAX,
            "pixelSizeM": (E_MAX - E_MIN) / ATLAS_PX,
        },
        "source": {
            "service": src_manifest.get("service", "https://www.ign.es/wms-inspire/pnoa-ma"),
            "layer": src_manifest.get("layer", "OI.OrthoimageCoverage"),
            "mosaicLayer": src_manifest.get("mosaic_layer", "OI.MosaicElement"),
            "dates": dates,
            "resolutions": resolutions,
            "tileCenterCount": len(centers),
            "fetchedUtc": src_manifest.get("fetched_utc", ""),
            "license": src_manifest.get("license", "CC BY 4.0 scne.es"),
            "attribution": src_manifest.get("attribution", "Ortofoto PNOA Máxima Actualidad, IGN/CNIG"),
            "sourceManifestSha256": hashlib.sha256(src_bytes).hexdigest(),
            "quadrants": {
                name: {
                    "sha256": src_manifest["quadrants"][name]["sha256"],
                    "bytes": src_manifest["quadrants"][name]["bytes"],
                }
                for name in QUADRANT_ORDER
            },
        },
        "encoding": {
            "format": MIME_WEBP,
            "quality": WEBP_QUALITY,
            "method": WEBP_METHOD,
            "pillowVersion": pillow_version(),
        },
        "budgets": {
            "fileBytes": len(webp_bytes),
            "fileMiB": round(len(webp_bytes) / (1024 * 1024), 2),
            "fileBudgetBytes": FILE_BUDGET_BYTES,
            **budgets,
            "decodedBudgetBytes": DECODED_BUDGET_BYTES,
        },
    }
    if len(webp_bytes) > FILE_BUDGET_BYTES:
        raise RuntimeError(f"WebP {len(webp_bytes)} bytes supera 35 MiB")
    if budgets["decodedRgbaPlusMipsBytes"] > DECODED_BUDGET_BYTES:
        raise RuntimeError(f"decoded+mips {budgets['decodedRgbaPlusMipsBytes']} supera 200 MiB")
    return manifest


def write_outputs() -> dict:
    webp_bytes = derive_atlas_bytes()
    manifest = build_manifest(webp_bytes)
    PUBLIC_DIR.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix="orthophoto-stage-", dir=str(PUBLIC_DIR)))
    try:
        (staging / "orthophoto.webp").write_bytes(webp_bytes)
        text = json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
        (staging / "orthophoto.json").write_text(text, encoding="utf-8")
        Path(f"{staging / 'orthophoto.webp'}").replace(WEBP_PATH)
        Path(f"{staging / 'orthophoto.json'}").replace(MANIFEST_PATH)
    finally:
        import shutil

        shutil.rmtree(staging, ignore_errors=True)
    return manifest


def check_outputs() -> int:
    if not WEBP_PATH.exists() or not MANIFEST_PATH.exists():
        print("[error] faltan public/terrain/orthophoto.webp u orthophoto.json; ejecuta el builder sin --check", file=sys.stderr)
        return 1
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    published = WEBP_PATH.read_bytes()
    rederived = derive_atlas_bytes()
    if rederived != published:
        print(
            f"[error] el atlas re-derivado difiere del publicado "
            f"(publicado sha256={hashlib.sha256(published).hexdigest()}, "
            f"re-derivado sha256={hashlib.sha256(rederived).hexdigest()})",
            file=sys.stderr,
        )
        return 1
    if manifest.get("asset", {}).get("sha256") != hashlib.sha256(published).hexdigest():
        print("[error] el manifiesto no coincide con orthophoto.webp publicado", file=sys.stderr)
        return 1
    if manifest.get("asset", {}).get("bytes") != len(published):
        print("[error] bytes del manifiesto no coinciden con orthophoto.webp", file=sys.stderr)
        return 1
    print(
        f"[ok] --check identical: {len(published)} bytes "
        f"sha256={hashlib.sha256(published).hexdigest()} "
        f"{ATLAS_PX}x{ATLAS_PX} north-up EPSG:25830 "
        f"E[{E_MIN},{E_MAX}] N[{N_MIN},{N_MAX}]"
    )
    return 0


def main(argv: list[str]) -> int:
    if len(argv) > 1 and argv[1] == "--check":
        return check_outputs()
    if len(argv) > 1:
        print(f"[error] argumento desconocido: {argv[1]} (uso: [--check])", file=sys.stderr)
        return 2
    manifest = write_outputs()
    asset = manifest["asset"]
    print(f"[ok] atlas -> {WEBP_PATH} ({asset['bytes']} bytes sha256={asset['sha256']})")
    print(f"[ok] manifest -> {MANIFEST_PATH}")
    print(
        f"[ok] {asset['width']}x{asset['height']} pixelSizeM={manifest['coverage']['pixelSizeM']} "
        f"decoded+mips={manifest['budgets']['decodedRgbaPlusMipsBytes']} bytes "
        f"({manifest['budgets']['decodedRgbaPlusMipsMiB']} MiB)"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
