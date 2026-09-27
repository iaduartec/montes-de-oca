#!/usr/bin/env python3
"""Mocked WMS checks for the PNOA orthophoto source fetcher (Task 1).

Nunca toca la red: sustituye ``fetch_pnoa_orthophoto.http_get`` por un doble
programable. El fetcher real vive en ``scripts/terrain/fetch_pnoa_orthophoto.py``.
"""
from __future__ import annotations

import importlib
import json
import struct
import sys
import tempfile
import urllib.parse
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[2]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))
SCRIPTS_TERRAIN = PROJECT_ROOT / "scripts" / "terrain"
if str(SCRIPTS_TERRAIN) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_TERRAIN))

import fetch_pnoa_orthophoto as F


def make_jpeg(width: int, height: int, truncated: bool = False) -> bytes:
    """JPEG mínimo con SOF0 declarando width×height (sin Pillow)."""
    sof0 = (
        b"\xff\xc0"
        + struct.pack(">H", 11)
        + bytes([8])
        + struct.pack(">HH", height, width)
        + bytes([1, 1, 0x11, 0, 0x11, 1])
    )
    out = b"\xff\xd8" + sof0
    if truncated:
        return out  # sin EOI -> corrupto
    return out + b"\xff\xd9"


CAPABILITIES_OK = """<?xml version="1.0" encoding="UTF-8"?>
<WMS_Capabilities version="1.3.0" xmlns="http://www.opengis.net/wms">
  <Service><MaxWidth>4096</MaxWidth><MaxHeight>4096</MaxHeight></Service>
  <Capability><Layer>
    <Layer><Name>OI.OrthoimageCoverage</Name><Title>Ortoimagen</Title></Layer>
    <Layer queryable="1"><Name>OI.MosaicElement</Name><Title>Mosaico</Title></Layer>
  </Layer></Capability>
</WMS_Capabilities>""".encode("utf-8")

GFI_OK = json.dumps(
    {"type": "FeatureCollection", "features": [{"properties": {"Fecha": "2023-09", "Resolucion": "0.25"}}]}
).encode("utf-8")


class MockHTTP:
    """Doble programable de F.http_get(url) -> (content_type, payload)."""

    def __init__(self) -> None:
        self.urls: list[str] = []
        self.getmap_payload = make_jpeg(3072, 3072)
        self.getmap_content_type = "image/jpeg"
        self.gfi_payload = GFI_OK
        self.gfi_content_type = "application/json"
        self.fail_getmap = False
        self.drop_fecha_for: tuple | None = None

    def __call__(self, url: str) -> tuple[str, bytes]:
        self.urls.append(url)
        q = urllib.parse.parse_qs(urllib.parse.urlparse(url).query, keep_blank_values=True)
        req = (q.get("request", [""])[0] or "").lower()
        if req == "getcapabilities":
            return ("text/xml", CAPABILITIES_OK)
        if req == "getfeatureinfo":
            if self.drop_fecha_for is not None:
                bbox = q.get("bbox", [""])[0]
                e0, n0, e1, n1 = (float(v) for v in bbox.split(","))
                ec, nc = ((e0 + e1) / 2.0, (n0 + n1) / 2.0)
                if abs(ec - self.drop_fecha_for[0]) < 1.0 and abs(nc - self.drop_fecha_for[1]) < 1.0:
                    return (
                        self.gfi_content_type,
                        json.dumps(
                            {"type": "FeatureCollection", "features": [{"properties": {}}]}
                        ).encode("utf-8"),
                    )
            return (self.gfi_content_type, self.gfi_payload)
        if req == "getmap":
            if self.fail_getmap:
                raise RuntimeError("boom simulado en GetMap")
            return (self.getmap_content_type, self.getmap_payload)
        raise AssertionError(f"request WMS inesperado: {req!r} en {url!r}")


def fresh_outdir() -> Path:
    tmp = Path(tempfile.mkdtemp(prefix="pnoa-test-"))
    return tmp / "pnoa_orthophoto"


def test_getmap_quadrants_match_config_extent() -> None:
    mock = MockHTTP()
    F.http_get = mock  # type: ignore[method-assign]
    outdir = fresh_outdir()
    F.capture(out_dir=outdir)
    getmaps = [u for u in mock.urls if "getmap" in u.lower()]
    assert len(getmaps) == 4, f"se esperaban 4 GetMap, hubo {len(getmaps)}"
    bboxes = set()
    for u in getmaps:
        q = urllib.parse.parse_qs(urllib.parse.urlparse(u).query, keep_blank_values=True)
        assert q["crs"][0] == "EPSG:25830", q
        assert q["layers"][0] == "OI.OrthoimageCoverage", q
        assert q["width"][0] == "3072" and q["height"][0] == "3072", q
        assert q["format"][0] == "image/jpeg", q
        bboxes.add(q["bbox"][0])
    expected = {
        "471500,4692000,474500,4695000",  # nw
        "474500,4692000,477500,4695000",  # ne
        "471500,4689000,474500,4692000",  # sw
        "474500,4689000,477500,4692000",  # se
    }
    assert bboxes == expected, f"BBOX distintos del extent 6x6km: {sorted(bboxes)}"
    for name in ("nw", "ne", "sw", "se"):
        assert (outdir / f"{name}.jpg").exists(), f"falta {name}.jpg"
    manifest = json.loads((outdir / "source_manifest.json").read_text(encoding="utf-8"))
    assert manifest["crs"] == "EPSG:25830"
    assert manifest["bounds"] == {"e_min": 471500, "n_min": 4689000, "e_max": 477500, "n_max": 4695000}
    assert len(manifest["tile_centers"]) == 36, "se exigen los 36 centros de tesela de 1 km"


def test_rejects_nonimage_content_type() -> None:
    mock = MockHTTP()
    mock.getmap_content_type = "text/xml"
    mock.getmap_payload = b"<ServiceExceptionReport/>"
    F.http_get = mock  # type: ignore[method-assign]
    try:
        F.capture(out_dir=fresh_outdir())
    except RuntimeError:
        return
    raise AssertionError("debió rechazar Content-Type no imagen")


def test_rejects_bad_image_or_wrong_dimensions() -> None:
    for bad in (make_jpeg(3072, 3072, truncated=True), make_jpeg(64, 64), b"no-es-jpeg"):
        mock = MockHTTP()
        mock.getmap_payload = bad
        mock.getmap_content_type = "image/jpeg"
        F.http_get = mock  # type: ignore[method-assign]
        try:
            F.capture(out_dir=fresh_outdir())
        except RuntimeError:
            continue
        raise AssertionError(f"debió rechazar imagen mala (len={len(bad)})")


def test_requires_date_resolution_for_each_tile_center() -> None:
    mock = MockHTTP()
    mock.drop_fecha_for = (472000.0, 4689500.0)
    F.http_get = mock  # type: ignore[method-assign]
    try:
        F.capture(out_dir=fresh_outdir())
    except RuntimeError as exc:
        low = str(exc).lower()
        assert "fecha" in low or "resolucion" in low or "resolución" in low, str(exc)
        return
    raise AssertionError("debió exigir fecha/resolución oficial para cada centro")


def test_failed_refetch_preserves_previous_snapshot() -> None:
    mock_ok = MockHTTP()
    F.http_get = mock_ok  # type: ignore[method-assign]
    outdir = fresh_outdir()
    F.capture(out_dir=outdir)
    before = {p.name: p.read_bytes() for p in sorted(outdir.glob("*"))}
    assert set(before) == {"ne.jpg", "nw.jpg", "se.jpg", "source_manifest.json", "sw.jpg"}, set(before)
    mock_fail = MockHTTP()
    mock_fail.fail_getmap = True
    F.http_get = mock_fail  # type: ignore[method-assign]
    try:
        F.capture(out_dir=outdir)
    except RuntimeError:
        pass
    else:
        raise AssertionError("el refetch roto debió fallar")
    after = {p.name: p.read_bytes() for p in sorted(outdir.glob("*"))}
    assert after == before, "el snapshot previo debe quedar intacto tras el fallo"


def test_publish_failure_rolls_back_to_previous_snapshot() -> None:
    """Fallo inyectado una sola vez tras mover aside el snapshot previo."""
    import pathlib

    def tagged_jpeg(tag: bytes) -> bytes:
        base = make_jpeg(3072, 3072)
        return base[:-2] + b"\xff\xfe" + struct.pack(">H", 2 + len(tag)) + tag + b"\xff\xd9"

    mock_ok = MockHTTP()
    mock_ok.getmap_payload = tagged_jpeg(b"v1")
    F.http_get = mock_ok  # type: ignore[method-assign]
    outdir = fresh_outdir()
    F.capture(out_dir=outdir)
    before = {p.name: p.read_bytes() for p in sorted(outdir.glob("*"))}
    assert set(before) == {"ne.jpg", "nw.jpg", "se.jpg", "source_manifest.json", "sw.jpg"}, set(before)
    parent = outdir.parent
    before_parent = {p.name for p in parent.iterdir()}

    orig_replace = pathlib.Path.replace
    calls = {"n": 0}

    def flaky_replace(self: Path, target: Path | str):  # type: ignore[no-untyped-def]
        calls["n"] += 1
        if calls["n"] == 2:
            raise RuntimeError("fallo inyectado en publicación tras mover snapshot previo")
        return orig_replace(self, target)

    mock_new = MockHTTP()
    mock_new.getmap_payload = tagged_jpeg(b"v2")
    assert mock_new.getmap_payload != mock_ok.getmap_payload
    pathlib.Path.replace = flaky_replace  # type: ignore[method-assign]
    try:
        F.http_get = mock_new  # type: ignore[method-assign]
        try:
            F.capture(out_dir=outdir)
        except RuntimeError as exc:
            assert "inyectado" in str(exc), f"se esperaba el fallo inyectado, hubo: {exc}"
        else:
            raise AssertionError("la publicación rota debió fallar")
    finally:
        pathlib.Path.replace = orig_replace  # type: ignore[method-assign]
    after = {p.name: p.read_bytes() for p in sorted(outdir.glob("*"))}
    assert after == before, "el snapshot previo debe quedar byte por byte intacto tras fallo de publicación"
    assert {p.name for p in parent.iterdir()} == before_parent | {outdir.name}, (
        f"no debe quedar staging/backup parcial: {sorted(p.name for p in parent.iterdir())}"
    )


TESTS = (
    test_getmap_quadrants_match_config_extent,
    test_rejects_nonimage_content_type,
    test_rejects_bad_image_or_wrong_dimensions,
    test_requires_date_resolution_for_each_tile_center,
    test_failed_refetch_preserves_previous_snapshot,
    test_publish_failure_rolls_back_to_previous_snapshot,
)


def main() -> int:
    failures = 0
    for fn in TESTS:
        importlib.reload(F)
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
