#!/usr/bin/env python3
"""Builder checks for the public PNOA atlas validator (Task 2).

TDD: the validator must expose a small testable ``validate(root)`` API and an
optional ``--root`` CLI flag so fixtures never touch the real public asset.
Every fixture is fully synthetic and offline: a deliberately compressible
6144 x 6144 WebP, matching temporary source quadrants and provenance files.

Negative controls prove the validator actually catches the failure modes from
the review focus: flipped quadrants, mismatched source/output hashes, missing
manifest fields, wrong bounds/dimensions/MIME/bytes, missing attribution and
budget overruns.
"""
from __future__ import annotations

import hashlib
import importlib
import io
import json
import subprocess
import sys
import tempfile
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[2]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))
SCRIPTS_TERRAIN = PROJECT_ROOT / "scripts" / "terrain"
if str(SCRIPTS_TERRAIN) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_TERRAIN))

import validate_terrain_orthophoto as V

E_MIN, E_MAX = 471500, 477500
N_MIN, N_MAX = 4689000, 4695000
ATLAS_PX = 6144
HALF_PX = ATLAS_PX // 2
QUAD_PX = 3072
ATLAS_URL = "/terrain/orthophoto.webp"
FILE_BUDGET_BYTES = 35 * 1024 * 1024
DECODED_BUDGET_BYTES = 200 * 1024 * 1024

# Distinct, highly compressible quadrant colours. A north/south flip puts
# blue/yellow on the top row, which the validator must detect by comparing
# each atlas quadrant against its pinned source.
QUADRANT_COLORS = {
    "nw": (255, 0, 0),  # red   -> top-left
    "ne": (0, 255, 0),  # green -> top-right
    "sw": (0, 0, 255),  # blue  -> bottom-left
    "se": (255, 255, 0),  # yellow -> bottom-right
}
# Deliberately corrupted placement: SW/SE pasted on top.
FLIPPED_COLORS = {
    "top-left": (0, 0, 255),
    "top-right": (255, 255, 0),
    "bottom-left": (255, 0, 0),
    "bottom-right": (0, 255, 0),
}


def _solid_png(color: tuple[int, int, int], size: int) -> bytes:
    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGB", (size, size), color).save(buf, format="PNG")
    return buf.getvalue()


def _encode_webp_from_quadrants(flipped: bool = False) -> bytes:
    """Compose a compressible 6144 atlas from the pinned/or flipped quadrants."""
    from PIL import Image

    atlas = Image.new("RGB", (ATLAS_PX, ATLAS_PX))
    if flipped:
        atlas.paste(Image.new("RGB", (HALF_PX, HALF_PX), (0, 0, 255)), (0, 0))
        atlas.paste(Image.new("RGB", (HALF_PX, HALF_PX), (255, 255, 0)), (HALF_PX, 0))
        atlas.paste(Image.new("RGB", (HALF_PX, HALF_PX), (255, 0, 0)), (0, HALF_PX))
        atlas.paste(Image.new("RGB", (HALF_PX, HALF_PX), (0, 255, 0)), (HALF_PX, HALF_PX))
    else:
        atlas.paste(Image.new("RGB", (HALF_PX, HALF_PX), QUADRANT_COLORS["nw"]), (0, 0))
        atlas.paste(Image.new("RGB", (HALF_PX, HALF_PX), QUADRANT_COLORS["ne"]), (HALF_PX, 0))
        atlas.paste(Image.new("RGB", (HALF_PX, HALF_PX), QUADRANT_COLORS["sw"]), (0, HALF_PX))
        atlas.paste(Image.new("RGB", (HALF_PX, HALF_PX), QUADRANT_COLORS["se"]), (HALF_PX, HALF_PX))
    buf = io.BytesIO()
    atlas.save(buf, format="WEBP", quality=60, method=4, lossless=False)
    return buf.getvalue()


def decoded_budgets() -> dict:
    decoded = ATLAS_PX * ATLAS_PX * 4
    factor = sum((1 / 4) ** level for level in range(12))
    with_mips = int(decoded * factor)
    return {
        "decodedRgbaBytes": decoded,
        "decodedRgbaPlusMipsBytes": with_mips,
        "decodedRgbaPlusMipsMiB": round(with_mips / (1024 * 1024), 2),
    }


def make_fixture_root(flipped: bool = False) -> Path:
    """Build a temporary root with source, provenance, atlas and attribution."""
    root = Path(tempfile.mkdtemp(prefix="orthophoto-validator-"))
    public_dir = root / "public" / "terrain"
    source_dir = root / "data" / "terrain" / "raw" / "pnoa_orthophoto"
    public_dir.mkdir(parents=True)
    source_dir.mkdir(parents=True)

    quadrants: dict[str, dict] = {}
    for name, bbox in (
        ("nw", [E_MIN, (N_MIN + N_MAX) // 2, (E_MIN + E_MAX) // 2, N_MAX]),
        ("ne", [(E_MIN + E_MAX) // 2, (N_MIN + N_MAX) // 2, E_MAX, N_MAX]),
        ("sw", [E_MIN, N_MIN, (E_MIN + E_MAX) // 2, (N_MIN + N_MAX) // 2]),
        ("se", [(E_MIN + E_MAX) // 2, N_MIN, E_MAX, (N_MIN + N_MAX) // 2]),
    ):
        data = _solid_png(QUADRANT_COLORS[name], 64)
        (source_dir / f"{name}.jpg").write_bytes(data)
        quadrants[name] = {
            "bbox": bbox,
            "crs": "EPSG:25830",
            "width_px": QUAD_PX,
            "height_px": QUAD_PX,
            "pixel_size_m": 3000 / QUAD_PX,
            "request_url": (
                "https://www.ign.es/wms-inspire/pnoa-ma?service=WMS&request=GetMap"
                f"&layers=OI.OrthoimageCoverage&crs=EPSG%3A25830&bbox={','.join(str(v) for v in bbox)}"
                f"&width={QUAD_PX}&height={QUAD_PX}&format=image%2Fjpeg"
            ),
            "response_content_type": "image/jpeg",
            "sha256": hashlib.sha256(data).hexdigest(),
            "bytes": len(data),
            "file": f"{name}.jpg",
        }

    tile_centers = [
        {"e": E_MIN + 500 + 1000 * ix, "n": N_MIN + 500 + 1000 * iy, "date": "2023-09", "resolution_m": "0.25"}
        for iy in range(6)
        for ix in range(6)
    ]
    source_manifest = {
        "generator": "fixture",
        "fetched_utc": "2026-09-27T12:17:06.599281+00:00",
        "service": "https://www.ign.es/wms-inspire/pnoa-ma",
        "wms_version": "1.3.0",
        "layer": "OI.OrthoimageCoverage",
        "mosaic_layer": "OI.MosaicElement",
        "license": "CC BY 4.0 scne.es",
        "attribution": "Ortofoto PNOA Máxima Actualidad, IGN/CNIG",
        "crs": "EPSG:25830",
        "bounds": {"e_min": E_MIN, "n_min": N_MIN, "e_max": E_MAX, "n_max": N_MAX},
        "quadrants": quadrants,
        "tile_centers": tile_centers,
    }
    source_bytes = (json.dumps(source_manifest, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    (source_dir / "source_manifest.json").write_bytes(source_bytes)

    webp = _encode_webp_from_quadrants(flipped=flipped)
    (public_dir / "orthophoto.webp").write_bytes(webp)
    from PIL import Image

    gltf_dir = public_dir / "3d-tiles" / "tiles"
    gltf_dir.mkdir(parents=True)
    jpeg_buffer = io.BytesIO()
    Image.open(io.BytesIO(webp)).convert("RGB").save(jpeg_buffer, format="JPEG", quality=90)
    gltf_jpeg = jpeg_buffer.getvalue()
    (gltf_dir / "orthophoto.jpg").write_bytes(gltf_jpeg)

    manifest = {
        "schemaVersion": 1,
        "generator": "scripts/terrain/build_terrain_orthophoto.py",
        "pillowVersion": "12.3.0",
        "asset": {
            "url": ATLAS_URL,
            "mimeType": "image/webp",
            "width": ATLAS_PX,
            "height": ATLAS_PX,
            "bytes": len(webp),
            "sha256": hashlib.sha256(webp).hexdigest(),
        },
        "gltfAsset": {
            "url": "/terrain/3d-tiles/tiles/orthophoto.jpg",
            "mimeType": "image/jpeg",
            "bytes": len(gltf_jpeg),
            "sha256": hashlib.sha256(gltf_jpeg).hexdigest(),
        },
        "coverage": {
            "crs": "EPSG:25830",
            "eMin": E_MIN,
            "eMax": E_MAX,
            "nMin": N_MIN,
            "nMax": N_MAX,
            "pixelSizeM": (E_MAX - E_MIN) / ATLAS_PX,
        },
        "source": {
            "service": "https://www.ign.es/wms-inspire/pnoa-ma",
            "layer": "OI.OrthoimageCoverage",
            "mosaicLayer": "OI.MosaicElement",
            "dates": ["2023-09"],
            "resolutions": ["0.25"],
            "tileCenterCount": len(tile_centers),
            "fetchedUtc": "2026-09-27T12:17:06.599281+00:00",
            "license": "CC BY 4.0 scne.es",
            "attribution": "Ortofoto PNOA Máxima Actualidad, IGN/CNIG",
            "sourceManifestSha256": hashlib.sha256(source_bytes).hexdigest(),
            "quadrants": {
                name: {"sha256": quadrants[name]["sha256"], "bytes": quadrants[name]["bytes"]}
                for name in ("nw", "ne", "sw", "se")
            },
        },
        "encoding": {"format": "image/webp", "quality": 60, "method": 4, "pillowVersion": "12.3.0"},
        "budgets": {
            "fileBytes": len(webp),
            "fileMiB": round(len(webp) / (1024 * 1024), 2),
            "fileBudgetBytes": FILE_BUDGET_BYTES,
            **decoded_budgets(),
            "decodedBudgetBytes": DECODED_BUDGET_BYTES,
        },
    }
    (public_dir / "orthophoto.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )

    (public_dir / "ATTRIBUTION.md").write_text(
        "\n".join(
            [
                "# Atribución — Terreno",
                "",
                "Ortofoto PNOA Máxima Actualidad del IGN/CNIG bajo CC BY 4.0",
                "(https://creativecommons.org/licenses/by/4.0/).",
                "Modelo Digital del Terreno © Instituto Geográfico Nacional (IGN-CNIG).",
            ]
        )
        + "\n",
        encoding="utf-8",
    )
    return root


def _rewrite_manifest(root: Path, mutate) -> None:
    path = root / "public" / "terrain" / "orthophoto.json"
    manifest = json.loads(path.read_text(encoding="utf-8"))
    mutate(manifest)
    path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def _expect_fail(root: Path, needle: str) -> None:
    """validate(root) must fail and name the broken field."""
    try:
        V.validate(root)
    except V.ValidationError as exc:
        assert needle.lower() in str(exc).lower(), f"se esperaba {needle!r} en: {exc}"
        return
    raise AssertionError(f"validate() debió fallar mencionando {needle!r}")


def test_valid_fixture_passes() -> None:
    root = make_fixture_root()
    report = V.validate(root)
    assert report["ok"] is True, report
    assert report["asset"]["width"] == ATLAS_PX and report["asset"]["height"] == ATLAS_PX
    assert report["coverage"]["crs"] == "EPSG:25830"
    assert report["budgets"]["fileBytes"] <= FILE_BUDGET_BYTES
    assert report["budgets"]["decodedRgbaPlusMipsBytes"] <= DECODED_BUDGET_BYTES


def test_missing_manifest_fields_fail() -> None:
    for field in ("schemaVersion", "asset", "gltfAsset", "coverage", "source", "budgets"):
        root = make_fixture_root()
        _rewrite_manifest(root, lambda m, f=field: m.pop(f, None))
        _expect_fail(root, field)

    root = make_fixture_root()
    _rewrite_manifest(root, lambda m: m["asset"].pop("sha256", None))
    _expect_fail(root, "sha256")

    root = make_fixture_root()
    _rewrite_manifest(root, lambda m: m["source"].pop("dates", None))
    _expect_fail(root, "dates")


def test_exact_bounds_and_dimensions_are_enforced() -> None:
    # Wrong CRS.
    root = make_fixture_root()
    _rewrite_manifest(root, lambda m: m["coverage"].__setitem__("crs", "EPSG:4326"))
    _expect_fail(root, "crs")

    # Shifted / wrong bounds.
    root = make_fixture_root()
    _rewrite_manifest(root, lambda m: m["coverage"].__setitem__("eMin", E_MIN - 500))
    _expect_fail(root, "eMin")

    root = make_fixture_root()
    _rewrite_manifest(root, lambda m: m["coverage"].__setitem__("nMax", N_MAX + 500))
    _expect_fail(root, "nMax")

    # Declared dimensions must be exactly 6144 x 6144.
    root = make_fixture_root()
    _rewrite_manifest(root, lambda m: m["asset"].__setitem__("width", 4096))
    _expect_fail(root, "width")

    root = make_fixture_root()
    _rewrite_manifest(root, lambda m: m["asset"].__setitem__("height", 3072))
    _expect_fail(root, "height")


def test_asset_mime_bytes_and_sha256_are_enforced() -> None:
    root = make_fixture_root()
    _rewrite_manifest(root, lambda m: m["asset"].__setitem__("mimeType", "image/png"))
    _expect_fail(root, "mimeType")

    root = make_fixture_root()
    _rewrite_manifest(root, lambda m: m["asset"].__setitem__("bytes", 1))
    _expect_fail(root, "bytes")

    root = make_fixture_root()
    _rewrite_manifest(root, lambda m: m["asset"].__setitem__("sha256", "0" * 64))
    _expect_fail(root, "sha256")

    # Missing atlas file entirely.
    root = make_fixture_root()
    (root / "public" / "terrain" / "orthophoto.webp").unlink()
    _expect_fail(root, "orthophoto.webp")


def test_flipped_quadrants_are_detected() -> None:
    """A N/S-swapped atlas must fail even when every hash is self-consistent."""
    root = make_fixture_root(flipped=True)
    try:
        V.validate(root)
    except V.ValidationError as exc:
        text = str(exc).lower()
        assert "cuadrante" in text or "orientaci" in text or "espejado" in text, str(exc)
        return
    raise AssertionError("validate() debió detectar los cuadrantes volteados")


def test_mismatched_source_and_output_hashes_fail() -> None:
    # Source file corrupted after the source manifest pinned its hash.
    root = make_fixture_root()
    (root / "data" / "terrain" / "raw" / "pnoa_orthophoto" / "nw.jpg").write_bytes(b"corrupted")
    _expect_fail(root, "nw")

    # Public manifest quotes a source hash that no longer matches.
    root = make_fixture_root()
    _rewrite_manifest(root, lambda m: m["source"]["quadrants"]["nw"].__setitem__("sha256", "f" * 64))
    _expect_fail(root, "nw")

    # Source manifest is not the one the public manifest was derived from.
    root = make_fixture_root()
    src_path = root / "data" / "terrain" / "raw" / "pnoa_orthophoto" / "source_manifest.json"
    src = json.loads(src_path.read_text(encoding="utf-8"))
    src["fetched_utc"] = "2020-01-01T00:00:00+00:00"
    src_path.write_text(json.dumps(src, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    _expect_fail(root, "sourceManifestSha256")


def test_official_provenance_and_attribution_are_required() -> None:
    root = make_fixture_root()
    _rewrite_manifest(root, lambda m: m["source"].__setitem__("service", "https://example.com/wms"))
    _expect_fail(root, "service")

    root = make_fixture_root()
    _rewrite_manifest(root, lambda m: m["source"].__setitem__("layer", "OI.NotOrtho"))
    _expect_fail(root, "layer")

    root = make_fixture_root()
    _rewrite_manifest(root, lambda m: m["source"].__setitem__("license", "All rights reserved"))
    _expect_fail(root, "license")

    root = make_fixture_root()
    _rewrite_manifest(root, lambda m: m["source"].__setitem__("attribution", "Unknown"))
    _expect_fail(root, "attribution")

    # Attribution file must name IGN, CNIG, CC BY 4.0 and PNOA.
    for needle in ("IGN", "CNIG", "CC BY 4.0", "PNOA"):
        root = make_fixture_root()
        attr = root / "public" / "terrain" / "ATTRIBUTION.md"
        text = attr.read_text(encoding="utf-8").replace(needle, "X")
        attr.write_text(text, encoding="utf-8")
        _expect_fail(root, needle)


def test_budget_overruns_are_rejected() -> None:
    root = make_fixture_root()
    _expect_ok_budget = root / "public" / "terrain" / "orthophoto.json"
    manifest = json.loads(_expect_ok_budget.read_text(encoding="utf-8"))
    manifest["budgets"]["fileBudgetBytes"] = 1024  # smaller than the real file
    _expect_ok_budget.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    _expect_fail(root, "excede")

    root = make_fixture_root()
    _rewrite_manifest(root, lambda m: m["budgets"].__setitem__("decodedRgbaPlusMipsBytes", 300 * 1024 * 1024))
    _expect_fail(root, "decoded")


def test_cli_root_flag_and_exit_codes() -> None:
    good = make_fixture_root()
    proc = subprocess.run(
        [sys.executable, str(V.__file__), "--root", str(good)],
        capture_output=True,
        text=True,
    )
    assert proc.returncode == 0, f"CLI debió salir 0: {proc.stdout}\n{proc.stderr}"

    bad = make_fixture_root(flipped=True)
    proc = subprocess.run(
        [sys.executable, str(V.__file__), "--root", str(bad)],
        capture_output=True,
        text=True,
    )
    assert proc.returncode != 0, f"CLI debió salir distinto de 0: {proc.stdout}\n{proc.stderr}"


def test_real_public_asset_passes_when_present() -> None:
    """The real repo root validates once the other agent publishes the atlas."""
    root = PROJECT_ROOT
    manifest_path = root / "public" / "terrain" / "orthophoto.json"
    if not manifest_path.exists():
        print("  (omitido: public/terrain/orthophoto.json aún no existe)")
        return
    report = V.validate(root)
    assert report["ok"] is True, report


TESTS = (
    test_valid_fixture_passes,
    test_missing_manifest_fields_fail,
    test_exact_bounds_and_dimensions_are_enforced,
    test_asset_mime_bytes_and_sha256_are_enforced,
    test_flipped_quadrants_are_detected,
    test_mismatched_source_and_output_hashes_fail,
    test_official_provenance_and_attribution_are_required,
    test_budget_overruns_are_rejected,
    test_cli_root_flag_and_exit_codes,
    test_real_public_asset_passes_when_present,
)


def main() -> int:
    failures = 0
    for fn in TESTS:
        importlib.reload(V)
        try:
            fn()
        except Exception as exc:  # noqa: BLE001
            failures += 1
            print(f"[FAIL] {fn.__name__}: {exc}")
        else:
            print(f"[ok] {fn.__name__}")
    print(f"{len(TESTS) - failures}/{len(TESTS)} tests passed")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
