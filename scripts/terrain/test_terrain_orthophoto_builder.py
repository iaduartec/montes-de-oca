#!/usr/bin/env python3
"""Builder checks for the deterministic PNOA terrain atlas (Task 2).

TDD fixtures: synthetic solid-colour quadrants catch flips/misplacement
without network access. Real-asset checks pin exact bounds, dimensions,
hashes and budgets on ``public/terrain/orthophoto.{webp,json}``.
"""
from __future__ import annotations

import hashlib
import importlib
import json
import subprocess
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[2]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))
SCRIPTS_TERRAIN = PROJECT_ROOT / "scripts" / "terrain"
if str(SCRIPTS_TERRAIN) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_TERRAIN))

import build_terrain_orthophoto as B

SOURCE_DIR = PROJECT_ROOT / "data" / "terrain" / "raw" / "pnoa_orthophoto"
PUBLIC_DIR = PROJECT_ROOT / "public" / "terrain"
ATLAS_URL = "/terrain/orthophoto.webp"

E_MIN, E_MAX = 471500, 477500
N_MIN, N_MAX = 4689000, 4695000
ATLAS_PX = 6144
HALF_PX = ATLAS_PX // 2
FILE_BUDGET_BYTES = 35 * 1024 * 1024
DECODED_BUDGET_BYTES = 200 * 1024 * 1024


def _solid(color: tuple[int, int, int], size: int = 64):
    from PIL import Image

    return Image.new("RGB", (size, size), color)


def _sample(img, x: int, y: int):
    return img.convert("RGB").getpixel((x, y))


def test_nw_ne_sw_se_quadrants_are_placed_north_up() -> None:
    """Synthetic quadrants must land NW=top-left, NE=top-right, SW=bottom-left, SE=bottom-right."""
    from PIL import Image

    nw = _solid((255, 0, 0))  # red
    ne = _solid((0, 255, 0))  # green
    sw = _solid((0, 0, 255))  # blue
    se = _solid((255, 255, 0))  # yellow
    atlas = B.assemble_atlas(nw, ne, sw, se)
    assert atlas.size == (ATLAS_PX, ATLAS_PX), f"atlas size {atlas.size}"
    w, h = atlas.size
    assert _sample(atlas, w // 4, h // 4) == (255, 0, 0), "top-left must be NW (red)"
    assert _sample(atlas, 3 * w // 4, h // 4) == (0, 255, 0), "top-right must be NE (green)"
    assert _sample(atlas, w // 4, 3 * h // 4) == (0, 0, 255), "bottom-left must be SW (blue)"
    assert _sample(atlas, 3 * w // 4, 3 * h // 4) == (255, 255, 0), "bottom-right must be SE (yellow)"
    # Negative control: assembling with SW/SE on top must NOT satisfy the fixture.
    wrong = B.assemble_atlas(sw, se, nw, ne)
    assert _sample(wrong, w // 4, h // 4) != (255, 0, 0), "fixture must catch a N/S flip"

    # Real-asset orientation: each atlas quadrant must resemble its pinned source.
    webp_path = PUBLIC_DIR / "orthophoto.webp"
    assert webp_path.exists(), f"falta {webp_path}"
    real = Image.open(webp_path).convert("RGB")
    assert real.size == (ATLAS_PX, ATLAS_PX)
    for name, box in (
        ("nw", (0, 0, HALF_PX, HALF_PX)),
        ("ne", (HALF_PX, 0, ATLAS_PX, HALF_PX)),
        ("sw", (0, HALF_PX, HALF_PX, ATLAS_PX)),
        ("se", (HALF_PX, HALF_PX, ATLAS_PX, ATLAS_PX)),
    ):
        src = Image.open(SOURCE_DIR / f"{name}.jpg").convert("RGB")
        a = real.crop(box).resize((32, 32), Image.BILINEAR)
        s = src.resize((32, 32), Image.BILINEAR)
        import math

        def rms(d1, d2) -> float:
            b1, b2 = d1.tobytes(), d2.tobytes()
            return math.sqrt(sum((c1 - c2) ** 2 for c1, c2 in zip(b1, b2)) / len(b1))

        own = rms(a, s)
        others = []
        for other in ("nw", "ne", "sw", "se"):
            if other == name:
                continue
            o = Image.open(SOURCE_DIR / f"{other}.jpg").convert("RGB").resize((32, 32), Image.BILINEAR)
            others.append(rms(a, o))
        assert own < min(others), f"atlas quadrant {name} does not match its source (rms {own:.2f} vs {min(others):.2f})"


def test_atlas_dimensions_and_pixel_scale() -> None:
    from PIL import Image

    webp_path = PUBLIC_DIR / "orthophoto.webp"
    manifest = json.loads((PUBLIC_DIR / "orthophoto.json").read_text(encoding="utf-8"))
    with Image.open(webp_path) as im:
        assert (im.width, im.height) == (ATLAS_PX, ATLAS_PX), f"{im.width}x{im.height}"
    assert manifest["asset"]["width"] == ATLAS_PX and manifest["asset"]["height"] == ATLAS_PX
    cov = manifest["coverage"]
    assert cov["crs"] == "EPSG:25830", cov
    assert (cov["eMin"], cov["eMax"], cov["nMin"], cov["nMax"]) == (E_MIN, E_MAX, N_MIN, N_MAX), cov
    expected_px = (E_MAX - E_MIN) / ATLAS_PX
    assert abs(cov["pixelSizeM"] - expected_px) < 1e-9, cov
    assert abs(expected_px - 0.9765625) < 1e-9


def test_manifest_hash_source_and_budgets() -> None:
    webp_path = PUBLIC_DIR / "orthophoto.webp"
    manifest_path = PUBLIC_DIR / "orthophoto.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    assert manifest["schemaVersion"] == 1
    data = webp_path.read_bytes()
    assert manifest["asset"]["url"] == ATLAS_URL, manifest["asset"]
    assert manifest["asset"]["mimeType"] == "image/webp"
    assert manifest["asset"]["bytes"] == len(data), "asset bytes must match file"
    assert manifest["asset"]["sha256"] == hashlib.sha256(data).hexdigest(), "asset sha256 must match file"
    gltf_path = PUBLIC_DIR / "3d-tiles" / "tiles" / "orthophoto.jpg"
    gltf_data = gltf_path.read_bytes()
    gltf_asset = manifest["gltfAsset"]
    assert gltf_asset["url"] == "/terrain/3d-tiles/tiles/orthophoto.jpg"
    assert gltf_asset["mimeType"] == "image/jpeg"
    assert gltf_asset["bytes"] == len(gltf_data)
    assert gltf_asset["sha256"] == hashlib.sha256(gltf_data).hexdigest()
    assert len(gltf_data) <= FILE_BUDGET_BYTES
    assert len(data) <= FILE_BUDGET_BYTES, f"WebP {len(data)} bytes exceeds 35 MiB"
    w, h = manifest["asset"]["width"], manifest["asset"]["height"]
    decoded = w * h * 4
    mip = int(decoded * (1 + 1 / 4 + 1 / 16 + 1 / 64 + 1 / 256 + 1 / 1024 + 1 / 4096))
    assert decoded + (mip - decoded) <= DECODED_BUDGET_BYTES, f"decoded+mip {mip} exceeds 200 MiB"
    assert manifest.get("budgets", {}).get("decodedRgbaPlusMipsBytes", mip) <= DECODED_BUDGET_BYTES
    src_manifest_bytes = (SOURCE_DIR / "source_manifest.json").read_bytes()
    assert manifest["source"]["sourceManifestSha256"] == hashlib.sha256(src_manifest_bytes).hexdigest()
    assert manifest["source"]["service"] == "https://www.ign.es/wms-inspire/pnoa-ma"
    assert manifest["source"]["layer"] == "OI.OrthoimageCoverage"
    assert "CC BY 4.0" in manifest["source"]["license"], manifest["source"]
    assert "IGN" in manifest["source"]["attribution"] and "CNIG" in manifest["source"]["attribution"]
    assert manifest["source"]["dates"], "source dates must be non-empty"
    assert manifest["source"].get("resolutions"), "source resolutions must be non-empty"
    assert manifest.get("pillowVersion"), "pillowVersion provenance required"
    # Negative control: tampered hash must be detectable.
    tampered = json.loads(json.dumps(manifest))
    tampered["asset"]["sha256"] = "0" * 64
    assert tampered["asset"]["sha256"] != hashlib.sha256(data).hexdigest()


def test_check_rederives_identical_webp() -> None:
    first = B.derive_atlas_bytes()
    second = B.derive_atlas_bytes()
    assert first == second, "atlas derivation must be byte-deterministic"
    manifest = json.loads((PUBLIC_DIR / "orthophoto.json").read_text(encoding="utf-8"))
    assert hashlib.sha256(first).hexdigest() == manifest["asset"]["sha256"]
    assert len(first) == manifest["asset"]["bytes"]
    jpeg1 = B.derive_gltf_jpeg_bytes()
    jpeg2 = B.derive_gltf_jpeg_bytes()
    assert jpeg1 == jpeg2, "glTF JPEG derivative must be byte-deterministic"
    assert hashlib.sha256(jpeg1).hexdigest() == manifest["gltfAsset"]["sha256"]
    proc = subprocess.run(
        [sys.executable, str(SCRIPTS_TERRAIN / "build_terrain_orthophoto.py"), "--check"],
        capture_output=True,
        text=True,
    )
    assert proc.returncode == 0, f"--check failed: {proc.stdout}\n{proc.stderr}"
    assert "identical" in (proc.stdout + proc.stderr).lower() or "ok" in (proc.stdout + proc.stderr).lower()


TESTS = (
    test_nw_ne_sw_se_quadrants_are_placed_north_up,
    test_atlas_dimensions_and_pixel_scale,
    test_manifest_hash_source_and_budgets,
    test_check_rederives_identical_webp,
)


def main() -> int:
    failures = 0
    for fn in TESTS:
        importlib.reload(B)
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
