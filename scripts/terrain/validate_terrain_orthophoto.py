#!/usr/bin/env python3
"""Domain validator for the public PNOA terrain orthophoto (Task 2).

Checks the distributed atlas ``public/terrain/orthophoto.webp`` against its
provenance manifest ``public/terrain/orthophoto.json``, the pinned source
snapshot ``data/terrain/raw/pnoa_orthophoto/`` and the public attribution in
``public/terrain/ATTRIBUTION.md``. Exits nonzero for any missing or
inconsistent field, without network access and without Pillow unless a
dimension/decoded-budget check actually needs to open the image.

Validated contract (see docs/superpowers/plans/2026-09-27-terrain-orthophoto.md):

- public manifest required fields (schemaVersion, asset, coverage, source,
  budgets);
- exact EPSG:25830 bounds E[471500, 477500] N[4689000, 4695000] and a
  6144 x 6144 WebP with the declared MIME type, bytes and SHA-256;
- the four source quadrant files and their manifest hashes/bytes/CRS/bbox/
  dimensions;
- official layer/service/date/resolution provenance plus CC BY 4.0 and
  IGN/CNIG attribution in ``public/terrain/ATTRIBUTION.md``;
- north-up orientation (a flipped atlas is rejected by matching each atlas
  quadrant against its pinned source file);
- budgets: <= 35 MiB distributed file and <= 200 MiB decoded RGBA + mipmaps.

Usage:
    python3 scripts/terrain/validate_terrain_orthophoto.py [--root DIR]

``--root`` points the validator at a fixture directory for tests; it defaults
to the repository root. ``validate(root)`` is the testable API and raises
``ValidationError`` with the failing field named.
"""
from __future__ import annotations

import hashlib
import json
import math
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[2]

CRS = "EPSG:25830"
E_MIN, E_MAX = 471500, 477500
N_MIN, N_MAX = 4689000, 4695000
ATLAS_PX = 6144
HALF_PX = ATLAS_PX // 2
QUAD_PX = 3072
QUAD_M = 3000
ATLAS_URL = "/terrain/orthophoto.webp"
MIME_WEBP = "image/webp"
SCHEMA_VERSION = 1

FILE_BUDGET_BYTES = 35 * 1024 * 1024
DECODED_BUDGET_BYTES = 200 * 1024 * 1024

EXPECTED_SERVICE = "https://www.ign.es/wms-inspire/pnoa-ma"
EXPECTED_LAYER = "OI.OrthoimageCoverage"
EXPECTED_MOSAIC_LAYER = "OI.MosaicElement"

QUADRANT_ORDER = ("nw", "ne", "sw", "se")
QUADRANT_BBOX = {
    "nw": (E_MIN, (N_MIN + N_MAX) // 2, (E_MIN + E_MAX) // 2, N_MAX),
    "ne": ((E_MIN + E_MAX) // 2, (N_MIN + N_MAX) // 2, E_MAX, N_MAX),
    "sw": (E_MIN, N_MIN, (E_MIN + E_MAX) // 2, (N_MIN + N_MAX) // 2),
    "se": ((E_MIN + E_MAX) // 2, N_MIN, E_MAX, (N_MIN + N_MAX) // 2),
}
# Atlas placement: (left_px, top_px) of each source quadrant on the canvas.
QUADRANT_PLACEMENT = {
    "nw": (0, 0),
    "ne": (HALF_PX, 0),
    "sw": (0, HALF_PX),
    "se": (HALF_PX, HALF_PX),
}


class ValidationError(RuntimeError):
    """Raised for any missing or inconsistent orthophoto artifact field."""


def _fail(message: str) -> None:
    raise ValidationError(message)


def _load_json(path: Path, label: str) -> dict:
    if not path.exists():
        _fail(f"falta {label}: {path}")
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (ValueError, UnicodeDecodeError) as exc:
        _fail(f"{label} no es JSON válido ({path}): {exc}")
    if not isinstance(data, dict):
        _fail(f"{label} debe ser un objeto JSON ({path})")
    return data


def _require(mapping: dict, key: str, label: str, expected: object | None = None) -> object:
    if not isinstance(mapping, dict) or key not in mapping:
        _fail(f"campo requerido ausente en {label}: {key!r}")
    value = mapping[key]
    if expected is not None and value != expected:
        _fail(f"{label}.{key} = {value!r}; se esperaba {expected!r}")
    return value


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _decoded_with_mips(width: int, height: int) -> int:
    decoded = width * height * 4
    factor = sum((1 / 4) ** level for level in range(12))
    return int(decoded * factor)


def _image_dimensions(path: Path) -> tuple[int, int]:
    """Read declared WebP dimensions; Pillow is used only when available."""
    try:
        from PIL import Image
    except ImportError:  # pragma: no cover - Pillow is present in this repo
        _fail(
            f"Pillow no disponible para verificar las dimensiones de {path}; "
            "instalá Pillow o revisá el entorno del validator"
        )
    try:
        with Image.open(path) as image:
            return (image.width, image.height)
    except Exception as exc:  # noqa: BLE001
        _fail(f"no se pudo abrir el atlas WebP {path}: {exc}")


def _mean_rgb(pixels: list[tuple[int, int, int]]) -> tuple[float, float, float]:
    count = len(pixels) or 1
    return (
        sum(p[0] for p in pixels) / count,
        sum(p[1] for p in pixels) / count,
        sum(p[2] for p in pixels) / count,
    )


def _flattened(image) -> list[tuple[int, int, int]]:
    """Pixel list without the Pillow 14 ``getdata`` deprecation warning."""
    getter = getattr(image, "get_flattened_data", None)
    if getter is not None:
        return list(getter())
    return list(image.getdata())


def _rms(a: tuple[float, float, float], b: tuple[float, float, float]) -> float:
    return math.sqrt(sum((x - y) ** 2 for x, y in zip(a, b)) / 3.0)


def _quadrant_signature(image, box: tuple[int, int, int, int]) -> tuple[float, float, float]:
    crop = image.crop(box).convert("RGB").resize((16, 16))
    return _mean_rgb(_flattened(crop))


def _check_orientation(atlas_path: Path, source_dir: Path, coverage: dict) -> None:
    """Reject a flipped/misplaced atlas by comparing it to the pinned sources."""
    from PIL import Image

    with Image.open(atlas_path) as atlas_raw:
        atlas = atlas_raw.convert("RGB")

    for name in QUADRANT_ORDER:
        left, top = QUADRANT_PLACEMENT[name]
        atlas_sig = _quadrant_signature(atlas, (left, top, left + HALF_PX, top + HALF_PX))

        source_path = source_dir / f"{name}.jpg"
        if not source_path.exists():
            _fail(f"falta el cuadrante fuente {name}.jpg en {source_dir}")
        with Image.open(source_path) as source_raw:
            source = source_raw.convert("RGB").resize((16, 16))
        own = _rms(atlas_sig, _mean_rgb(_flattened(source)))

        closest_other = None
        for other in QUADRANT_ORDER:
            if other == name:
                continue
            other_path = source_dir / f"{other}.jpg"
            if not other_path.exists():
                continue
            with Image.open(other_path) as other_raw:
                other_img = other_raw.convert("RGB").resize((16, 16))
            distance = _rms(atlas_sig, _mean_rgb(_flattened(other_img)))
            closest_other = distance if closest_other is None else min(closest_other, distance)

        if closest_other is not None and own >= closest_other:
            _fail(
                f"orientación del cuadrante {name} invertida o mal ubicada: el atlas "
                f"se parece más a otra fuente (rms propio {own:.2f} >= {closest_other:.2f}); "
                "se rechaza un atlas norte-sur espejado"
            )


def _check_source_manifest(source_dir: Path, public_source: dict) -> dict:
    src_path = source_dir / "source_manifest.json"
    src_manifest = _load_json(src_path, "source_manifest.json")

    _require(src_manifest, "service", "source_manifest")
    _require(src_manifest, "layer", "source_manifest")
    _require(src_manifest, "mosaic_layer", "source_manifest")
    _require(src_manifest, "license", "source_manifest")
    _require(src_manifest, "attribution", "source_manifest")
    _require(src_manifest, "bounds", "source_manifest")
    _require(src_manifest, "quadrants", "source_manifest")
    _require(src_manifest, "tile_centers", "source_manifest")

    bounds = src_manifest["bounds"]
    if (
        bounds.get("e_min") != E_MIN
        or bounds.get("e_max") != E_MAX
        or bounds.get("n_min") != N_MIN
        or bounds.get("n_max") != N_MAX
    ):
        _fail(f"source_manifest.bounds no coincide con el extent exacto: {bounds!r}")

    centers = src_manifest["tile_centers"]
    if not isinstance(centers, list) or not centers:
        _fail("source_manifest.tile_centers debe listar la procedencia por tesela")
    for center in centers:
        date = str(center.get("date", "")).strip() if isinstance(center, dict) else ""
        resolution = str(center.get("resolution_m", "")).strip() if isinstance(center, dict) else ""
        if not date or not resolution:
            _fail(f"procedencia oficial fecha/resolución ausente en un centro de tesela: {center!r}")

    source_dir_quadrants = src_manifest["quadrants"]
    declared_quadrants = public_source.get("quadrants")
    if not isinstance(declared_quadrants, dict):
        _fail("source.quadrants ausente en el manifiesto público")

    for name in QUADRANT_ORDER:
        entry = source_dir_quadrants.get(name)
        if not isinstance(entry, dict):
            _fail(f"source_manifest sin el cuadrante {name!r}")
        _require(entry, "bbox", f"source_manifest.quadrants.{name}", list(QUADRANT_BBOX[name]))
        _require(entry, "sha256", f"source_manifest.quadrants.{name}")
        _require(entry, "bytes", f"source_manifest.quadrants.{name}")
        _require(entry, "width_px", f"source_manifest.quadrants.{name}", QUAD_PX)
        _require(entry, "height_px", f"source_manifest.quadrants.{name}", QUAD_PX)
        _require(entry, "crs", f"source_manifest.quadrants.{name}", CRS)

        source_file = source_dir / f"{name}.jpg"
        if not source_file.exists():
            _fail(f"falta el cuadrante fuente {name}.jpg en {source_dir}")
        digest = _sha256(source_file)
        if digest != entry["sha256"]:
            _fail(
                f"hash del cuadrante fuente {name}.jpg no coincide con source_manifest.json "
                f"({digest} != {entry['sha256']})"
            )
        if source_file.stat().st_size != entry["bytes"]:
            _fail(
                f"bytes del cuadrante fuente {name}.jpg no coinciden con source_manifest.json "
                f"({source_file.stat().st_size} != {entry['bytes']})"
            )

        declared = declared_quadrants.get(name)
        if not isinstance(declared, dict):
            _fail(f"manifiesto público sin source.quadrants.{name}")
        if declared.get("sha256") != entry["sha256"]:
            _fail(
                f"source.quadrants.{name}.sha256 no coincide con la fuente fijada "
                f"({declared.get('sha256')!r} != {entry['sha256']!r})"
            )
        if declared.get("bytes") != entry["bytes"]:
            _fail(
                f"source.quadrants.{name}.bytes no coincide con la fuente fijada "
                f"({declared.get('bytes')!r} != {entry['bytes']!r})"
            )

    return src_manifest


def _check_attribution(attribution_path: Path) -> None:
    if not attribution_path.exists():
        _fail(f"falta la atribución pública: {attribution_path}")
    text = attribution_path.read_text(encoding="utf-8")
    for needle in ("IGN", "CNIG", "CC BY 4.0", "PNOA"):
        if needle not in text:
            _fail(f"ATTRIBUTION.md no menciona {needle!r} (atribución PNOA/IGN/CNIG CC BY 4.0 incompleta)")


def validate(root: str | Path = PROJECT_ROOT) -> dict:
    """Validate the orthophoto artifacts under ``root``; return a summary dict.

    Raises ``ValidationError`` naming the first missing or inconsistent field.
    """
    root = Path(root)
    public_dir = root / "public" / "terrain"
    source_dir = root / "data" / "terrain" / "raw" / "pnoa_orthophoto"
    manifest_path = public_dir / "orthophoto.json"
    atlas_path = public_dir / "orthophoto.webp"
    attribution_path = public_dir / "ATTRIBUTION.md"

    manifest = _load_json(manifest_path, "public/terrain/orthophoto.json")

    # --- schema and required top-level sections -------------------------
    _require(manifest, "schemaVersion", "orthophoto.json", SCHEMA_VERSION)
    asset = _require(manifest, "asset", "orthophoto.json")
    coverage = _require(manifest, "coverage", "orthophoto.json")
    source = _require(manifest, "source", "orthophoto.json")
    budgets = _require(manifest, "budgets", "orthophoto.json")
    for section, label in ((asset, "asset"), (coverage, "coverage"), (source, "source"), (budgets, "budgets")):
        if not isinstance(section, dict):
            _fail(f"{label} debe ser un objeto en orthophoto.json")

    # --- asset: URL, MIME, dimensions, bytes, SHA-256 -------------------
    _require(asset, "url", "asset", ATLAS_URL)
    _require(asset, "mimeType", "asset", MIME_WEBP)
    _require(asset, "width", "asset", ATLAS_PX)
    _require(asset, "height", "asset", ATLAS_PX)
    _require(asset, "bytes", "asset")
    _require(asset, "sha256", "asset")
    if not atlas_path.exists():
        _fail(f"falta el atlas público: {atlas_path}")
    actual_bytes = atlas_path.stat().st_size
    if asset["bytes"] != actual_bytes:
        _fail(f"asset.bytes = {asset['bytes']} no coincide con orthophoto.webp ({actual_bytes} bytes)")
    actual_sha = _sha256(atlas_path)
    if asset["sha256"] != actual_sha:
        _fail(f"asset.sha256 = {asset['sha256']!r} no coincide con orthophoto.webp ({actual_sha})")
    if atlas_path.read_bytes()[:4] != b"RIFF":
        _fail("orthophoto.webp no tiene cabecera RIFF: no es un WebP")
    image_width, image_height = _image_dimensions(atlas_path)
    if (image_width, image_height) != (asset["width"], asset["height"]):
        _fail(
            f"dimensiones reales del atlas {image_width}x{image_height} no coinciden con el "
            f"manifiesto {asset['width']}x{asset['height']}"
        )
    if (image_width, image_height) != (ATLAS_PX, ATLAS_PX):
        _fail(f"el atlas debe ser {ATLAS_PX}x{ATLAS_PX}; mide {image_width}x{image_height}")

    # --- coverage: exact CRS, bounds and pixel scale --------------------
    _require(coverage, "crs", "coverage", CRS)
    _require(coverage, "eMin", "coverage", E_MIN)
    _require(coverage, "eMax", "coverage", E_MAX)
    _require(coverage, "nMin", "coverage", N_MIN)
    _require(coverage, "nMax", "coverage", N_MAX)
    _require(coverage, "pixelSizeM", "coverage")
    expected_pixel = (E_MAX - E_MIN) / ATLAS_PX
    if abs(float(coverage["pixelSizeM"]) - expected_pixel) > 1e-9:
        _fail(
            f"coverage.pixelSizeM = {coverage['pixelSizeM']!r} no coincide con "
            f"{expected_pixel} ({(E_MAX - E_MIN)} m / {ATLAS_PX} px)"
        )

    # --- source provenance and quadrant integrity -----------------------
    _require(source, "service", "source", EXPECTED_SERVICE)
    _require(source, "layer", "source", EXPECTED_LAYER)
    _require(source, "mosaicLayer", "source", EXPECTED_MOSAIC_LAYER)
    _require(source, "sourceManifestSha256", "source")
    dates = _require(source, "dates", "source")
    if not isinstance(dates, list) or not dates or not all(str(d).strip() for d in dates):
        _fail("source.dates debe ser una lista no vacía con las fechas oficiales del mosaico")
    resolutions = _require(source, "resolutions", "source")
    if not isinstance(resolutions, list) or not resolutions or not all(str(r).strip() for r in resolutions):
        _fail("source.resolutions debe ser una lista no vacía con la resolución oficial (m)")
    license_value = str(_require(source, "license", "source"))
    if "CC BY 4.0" not in license_value:
        _fail(f"source.license debe declarar CC BY 4.0: {license_value!r}")
    attribution_value = str(_require(source, "attribution", "source"))
    if "IGN" not in attribution_value or "CNIG" not in attribution_value:
        _fail(f"source.attribution debe nombrar IGN y CNIG: {attribution_value!r}")

    src_manifest = _check_source_manifest(source_dir, source)

    src_manifest_bytes = (source_dir / "source_manifest.json").read_bytes()
    if source["sourceManifestSha256"] != hashlib.sha256(src_manifest_bytes).hexdigest():
        _fail("source.sourceManifestSha256 no coincide con data/.../source_manifest.json")

    if source.get("tileCenterCount") not in (None, len(src_manifest["tile_centers"])):
        _fail(
            f"source.tileCenterCount = {source.get('tileCenterCount')!r} no coincide con "
            f"{len(src_manifest['tile_centers'])} centros de tesela"
        )

    # --- orientation: north-up placement must match pinned sources ------
    _check_orientation(atlas_path, source_dir, coverage)

    # --- budgets: file and decoded RGBA + mipmaps -----------------------
    _require(budgets, "fileBytes", "budgets")
    _require(budgets, "fileBudgetBytes", "budgets")
    _require(budgets, "decodedRgbaPlusMipsBytes", "budgets")
    _require(budgets, "decodedBudgetBytes", "budgets")
    if float(budgets["fileBudgetBytes"]) > FILE_BUDGET_BYTES:
        _fail(f"budgets.fileBudgetBytes = {budgets['fileBudgetBytes']} excede 35 MiB ({FILE_BUDGET_BYTES})")
    if actual_bytes > float(budgets["fileBudgetBytes"]):
        _fail(f"el atlas pesa {actual_bytes} bytes y excede el presupuesto declarado {budgets['fileBudgetBytes']}")
    if actual_bytes > FILE_BUDGET_BYTES:
        _fail(f"el atlas pesa {actual_bytes} bytes; excede el límite absoluto de 35 MiB")
    if budgets["fileBytes"] != actual_bytes:
        _fail(f"budgets.fileBytes = {budgets['fileBytes']} no coincide con orthophoto.webp ({actual_bytes})")

    expected_decoded = _decoded_with_mips(ATLAS_PX, ATLAS_PX)
    if budgets["decodedRgbaPlusMipsBytes"] != expected_decoded:
        _fail(
            f"budgets.decodedRgbaPlusMipsBytes = {budgets['decodedRgbaPlusMipsBytes']} no coincide con "
            f"{expected_decoded} para {ATLAS_PX}x{ATLAS_PX}"
        )
    if float(budgets["decodedBudgetBytes"]) > DECODED_BUDGET_BYTES:
        _fail(
            f"budgets.decodedBudgetBytes = {budgets['decodedBudgetBytes']} excede 200 MiB "
            f"({DECODED_BUDGET_BYTES})"
        )
    if expected_decoded > float(budgets["decodedBudgetBytes"]):
        _fail(
            f"RGBA decodificado con mips {expected_decoded} excede el presupuesto declarado "
            f"{budgets['decodedBudgetBytes']}"
        )
    if expected_decoded > DECODED_BUDGET_BYTES:
        _fail(f"RGBA decodificado con mips {expected_decoded} excede el límite absoluto de 200 MiB")

    # --- public attribution ---------------------------------------------
    _check_attribution(attribution_path)

    return {
        "ok": True,
        "asset": {"url": asset["url"], "mimeType": asset["mimeType"], "width": image_width, "height": image_height,
                   "bytes": actual_bytes, "sha256": actual_sha},
        "coverage": {"crs": coverage["crs"], "eMin": coverage["eMin"], "eMax": coverage["eMax"],
                      "nMin": coverage["nMin"], "nMax": coverage["nMax"], "pixelSizeM": coverage["pixelSizeM"]},
        "source": {"service": source["service"], "layer": source["layer"], "dates": list(dates),
                    "resolutions": list(resolutions), "license": license_value,
                    "attribution": attribution_value},
        "budgets": {
            "fileBytes": actual_bytes,
            "fileBudgetBytes": budgets["fileBudgetBytes"],
            "decodedRgbaPlusMipsBytes": expected_decoded,
            "decodedBudgetBytes": budgets["decodedBudgetBytes"],
        },
        "attribution": str(attribution_path),
    }


def main(argv: list[str]) -> int:
    root = PROJECT_ROOT
    if len(argv) > 1:
        if argv[1] != "--root" or len(argv) != 3:
            print(f"[error] uso: {Path(argv[0]).name} [--root DIR]", file=sys.stderr)
            return 2
        root = Path(argv[2])
    try:
        report = validate(root)
    except ValidationError as exc:
        print(f"[error] {exc}", file=sys.stderr)
        return 1
    asset = report["asset"]
    budgets = report["budgets"]
    print(
        f"[ok] orthophoto.webp {asset['width']}x{asset['height']} {asset['mimeType']} "
        f"{asset['bytes']} bytes sha256={asset['sha256']}"
    )
    print(
        f"[ok] coverage {report['coverage']['crs']} "
        f"E[{report['coverage']['eMin']},{report['coverage']['eMax']}] "
        f"N[{report['coverage']['nMin']},{report['coverage']['nMax']}] "
        f"pixelSizeM={report['coverage']['pixelSizeM']}"
    )
    print(
        f"[ok] source {report['source']['layer']} dates={report['source']['dates']} "
        f"resolutions={report['source']['resolutions']} license={report['source']['license']!r}"
    )
    print(
        f"[ok] budgets file={budgets['fileBytes']} <= {budgets['fileBudgetBytes']} | "
        f"decoded+mips={budgets['decodedRgbaPlusMipsBytes']} <= {budgets['decodedBudgetBytes']}"
    )
    print(f"[ok] attribution {report['attribution']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
