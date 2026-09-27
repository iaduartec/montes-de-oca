#!/usr/bin/env python3
"""Focused checks for Task 2: deterministic local 3D Tiles contents.

Two-level REPLACE LOD (40 m overview + 36 full-resolution 1 km leaves),
binary GLB payloads with an external PNOA reference, seam-continuous
normals, outward winding and deterministic --check mode.

They build into a temporary directory (never touch public files, never use
the network) and inspect the real generated artefacts.
"""
from __future__ import annotations

import json
import struct
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np

PROJECT_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(PROJECT_ROOT / "scripts" / "terrain"))

import build_3d_tiles as builder  # noqa: E402

TILE_IDS = [f"tile_{ix}_{iz}" for iz in range(6) for ix in range(6)]
N = 201
OVERVIEW_URI = "tiles/overview.glb"
OVERVIEW_NODES = 151
OVERVIEW_STEP_M = 40.0
ORTHOPHOTO_URI = "orthophoto.jpg"


def build_tmp(test: unittest.TestCase) -> Path:
    tmp = Path(test._tmp_dir)  # type: ignore[attr-defined]
    out = tmp / "3d-tiles"
    manifest = builder.build_tileset(out)
    test.assertEqual(manifest["tileCount"], 36)
    return out


def parse_glb(path: Path) -> tuple[dict, bytes]:
    raw = path.read_bytes()
    test = f"{path.name}"
    assert len(raw) >= 28, test
    magic, version, total = struct.unpack_from("<III", raw, 0)
    assert magic == 0x46546C67, f"{test}: bad GLB magic"
    assert version == 2, f"{test}: GLB version must be 2"
    assert total == len(raw), f"{test}: GLB total length mismatch"
    json_len, json_type = struct.unpack_from("<II", raw, 12)
    assert json_type == 0x4E4F534A, f"{test}: first chunk must be JSON"
    json_bytes = raw[20:20 + json_len]
    gltf = json.loads(json_bytes.decode("utf-8"))
    cursor = 20 + json_len
    assert cursor + 8 <= len(raw), f"{test}: missing BIN chunk header"
    bin_len, bin_type = struct.unpack_from("<II", raw, cursor)
    assert bin_type == 0x004E4942, f"{test}: second chunk must be BIN"
    blob = raw[cursor + 8:cursor + 8 + bin_len]
    assert len(blob) == bin_len, f"{test}: BIN truncated"
    assert cursor + 8 + bin_len == len(raw), f"{test}: trailing bytes"
    return gltf, blob


def decode_attr(gltf: dict, blob: bytes, name: str, components: int) -> np.ndarray:
    mesh = gltf["meshes"][0]["primitives"][0]
    if name == "INDICES":
        acc_index = mesh["indices"]
        count, fmt, comps = None, None, 1
    else:
        acc_index = mesh["attributes"][name]
        comps = components
    accessor = gltf["accessors"][acc_index]
    view = gltf["bufferViews"][accessor["bufferView"]]
    start = view.get("byteOffset", 0) + accessor.get("byteOffset", 0)
    count = accessor["count"]
    ctype = accessor["componentType"]
    if ctype == 5126:
        dtype, size = np.float32, 4
    elif ctype == 5123:
        dtype, size = np.uint16, 2
    else:
        raise AssertionError(f"unexpected componentType {ctype} for {name}")
    nbytes = count * comps * size
    assert view["byteOffset"] + view["byteLength"] <= len(blob), f"{name}: view outside BIN"
    assert start + nbytes <= len(blob), f"{name}: accessor outside BIN"
    arr = np.frombuffer(blob[start:start + nbytes], dtype=dtype).copy()
    return arr.reshape(count, comps) if comps > 1 else arr


def load_leaf(out: Path, tile_id: str) -> tuple[dict, bytes]:
    return parse_glb(out / "tiles" / f"{tile_id}.glb")


def source_grid(tile_id: str) -> dict:
    path = PROJECT_ROOT / "public" / "terrain" / "tiles" / f"{tile_id}.json"
    return json.loads(path.read_text(encoding="utf-8"))["grid"]


def global_heights() -> np.ndarray:
    """Stitch the 36 MDT05 tiles into one 1201x1201 absolute-height grid."""
    size = 6 * 200 + 1
    full = np.empty((size, size), dtype=np.float64)
    for iz in range(6):
        for ix in range(6):
            grid = source_grid(f"tile_{ix}_{iz}")
            local = np.array(grid["heights"], dtype=np.float64).reshape(N, N)
            full[iz * 200:iz * 200 + N, ix * 200:ix * 200 + N] = local
    return full


def overview_error_from_data() -> tuple[float, np.ndarray]:
    """Max |SW->NE triangle surface of 40 m overview - 5 m MDT samples."""
    full = global_heights()
    overview = full[::8, ::8]
    assert overview.shape == (OVERVIEW_NODES, OVERVIEW_NODES)
    worst = 0.0
    for gz in range(full.shape[0]):
        fz = gz / 8.0
        r0 = min(int(fz), OVERVIEW_NODES - 2)
        tz = fz - r0
        for gx in range(full.shape[1]):
            fx = gx / 8.0
            c0 = min(int(fx), OVERVIEW_NODES - 2)
            tx = fx - c0
            sw = overview[r0, c0]
            se = overview[r0, c0 + 1]
            nw = overview[r0 + 1, c0]
            ne = overview[r0 + 1, c0 + 1]
            interp = (
                sw * (1 - tx) + se * (tx - tz) + ne * tz
                if tx >= tz
                else sw * (1 - tz) + ne * tx + nw * (tz - tx)
            )
            diff = abs(float(full[gz, gx]) - float(interp))
            if diff > worst:
                worst = diff
    return worst, overview


class TilesBuilderTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="tiles-test-")
        self._tmp_dir = self._tmp.name
        self.addCleanup(self._tmp.cleanup)

    def test_all_36_tiles_match_config_extent(self) -> None:
        """Exact 6x6 / 36-tile REPLACE leaves plus a content-carrying root."""
        out = build_tmp(self)
        tileset = json.loads((out / "tileset.json").read_text(encoding="utf-8"))
        root = tileset["root"]
        self.assertEqual(root.get("refine"), "REPLACE")
        self.assertIn("content", root)
        self.assertTrue(str(root["content"]["uri"]).endswith(".glb"))
        children = root["children"]
        self.assertEqual(len(children), 36)
        seen = set()
        for child in children:
            uri = child["content"]["uri"]
            self.assertTrue(uri.endswith(".glb"), uri)
            tile_id = Path(uri).stem
            seen.add(tile_id)
            ix = int(tile_id.split("_")[1])
            iz = int(tile_id.split("_")[2])
            box = child["boundingVolume"]["box"]
            cx, cy, cz = box[0], box[1], box[2]
            hx, hy, hz = box[3], box[7], box[11]
            self.assertAlmostEqual(cx, ix * 1000.0 + 500.0, places=6)
            self.assertAlmostEqual(cz, -(iz * 1000.0 + 500.0), places=6)
            self.assertAlmostEqual(hx, 500.0, places=6)
            self.assertAlmostEqual(hz, 500.0, places=6)
            self.assertEqual(child.get("geometricError"), 0.0)
            self.assertTrue((out / uri).exists(), f"missing content {uri}")
            grid = source_grid(tile_id)
            self.assertEqual((grid["columns"], grid["rows"]), (201, 201))
            self.assertAlmostEqual(hy, (max(grid["heights"]) - min(grid["heights"])) / 2.0, places=3)
        self.assertEqual(seen, set(TILE_IDS))
        root_box = root["boundingVolume"]["box"]
        self.assertAlmostEqual(root_box[0], 3000.0, places=6)
        self.assertAlmostEqual(root_box[2], -3000.0, places=6)
        self.assertAlmostEqual(root_box[3], 3000.0, places=6)
        self.assertAlmostEqual(root_box[11], 3000.0, places=6)

    def test_neighbor_edges_share_identical_height_samples(self) -> None:
        """Adjacent mesh edge height samples are exactly equal (no seams)."""
        out = build_tmp(self)
        meshes = {}
        for tid in TILE_IDS:
            gltf, blob = load_leaf(out, tid)
            pos = decode_attr(gltf, blob, "POSITION", 3)
            ys = pos[:, 1].reshape(N, N).tolist()
            self.assertEqual(len(ys) * len(ys[0]), N * N)
            meshes[tid] = ys
        grids = {tid: source_grid(tid) for tid in TILE_IDS}
        for iz in range(6):
            for ix in range(6):
                tid = f"tile_{ix}_{iz}"
                datum = builder.VERTICAL_DATUM
                grid = grids[tid]
                mesh = meshes[tid]
                for r in (0, 100, 200):
                    for c in (0, 100, 200):
                        expected = grid["heights"][r * 201 + c] - datum
                        self.assertAlmostEqual(mesh[r][c], expected, places=4)
                if ix < 5:
                    east = [mesh[r][200] for r in range(201)]
                    other = meshes[f"tile_{ix + 1}_{iz}"]
                    west = [other[r][0] for r in range(201)]
                    self.assertEqual(east, west, f"seam {tid} E / tile_{ix + 1}_{iz} W")
                if iz < 5:
                    north = meshes[tid][200]
                    other = meshes[f"tile_{ix}_{iz + 1}"]
                    south = other[0]
                    self.assertEqual(north, south, f"seam {tid} N / tile_{ix}_{iz + 1} S")

    def test_neighbor_tile_normals_match_at_shared_edges(self) -> None:
        """Shared-edge normals use both neighbours: equal within 1e-6."""
        out = build_tmp(self)
        normals = {}
        for tid in TILE_IDS:
            gltf, blob = load_leaf(out, tid)
            nrm = decode_attr(gltf, blob, "NORMAL", 3)
            normals[tid] = nrm.reshape(N, N, 3)
        for iz in range(6):
            for ix in range(6):
                tid = f"tile_{ix}_{iz}"
                base = normals[tid]
                if ix < 5:
                    east = base[:, 200, :]
                    west = normals[f"tile_{ix + 1}_{iz}"][:, 0, :]
                    worst = float(np.abs(east - west).max())
                    self.assertLessEqual(worst, 1e-6, f"seam normals E/W {tid}")
                if iz < 5:
                    north = base[200, :, :]
                    south = normals[f"tile_{ix}_{iz + 1}"][0, :, :]
                    worst = float(np.abs(north - south).max())
                    self.assertLessEqual(worst, 1e-6, f"seam normals N/S {tid}")

    def test_mesh_winding_and_normals_face_up(self) -> None:
        """RH triangles stay CCW-up with outward (positive-Y) normals."""
        out = build_tmp(self)
        gltf, blob = load_leaf(out, "tile_2_3")
        pos = decode_attr(gltf, blob, "POSITION", 3)
        nrm = decode_attr(gltf, blob, "NORMAL", 3)
        idx = decode_attr(gltf, blob, "INDICES", 1).astype(np.int64)
        self.assertEqual(len(idx), 200 * 200 * 6)
        self.assertTrue(bool((idx >= 0).all() and (idx < N * N).all()))
        # First cell keeps the sampler SW->NE split, re-wound for RH.
        self.assertEqual(idx[:6].tolist(), [0, 1, 202, 0, 202, 201])
        # Sampled faces must point up (+Y) in the RH frame.
        for t in range(0, len(idx), 997 * 3):
            a, b, c = pos[idx[t]], pos[idx[t + 1]], pos[idx[t + 2]]
            face = np.cross(b - a, c - a)
            self.assertGreater(float(face[1]), 0.0, f"triangle at {t} faces down")
        lengths = np.linalg.norm(nrm, axis=1)
        self.assertTrue(bool(((lengths - 1.0) < 1e-3).all()))
        self.assertTrue(bool((nrm[:, 1] > 0.0).all()))

    def test_mesh_heights_use_config_vertical_datum(self) -> None:
        """Mesh Y = absolute MDT05 height minus the config verticalDatum (870)."""
        out = build_tmp(self)
        config = json.loads((PROJECT_ROOT / "public" / "terrain" / "config.json").read_text(encoding="utf-8"))
        self.assertEqual(config["verticalDatum"], builder.VERTICAL_DATUM)
        self.assertEqual(config["crs"], "EPSG:25830")
        gltf, blob = load_leaf(out, "tile_2_3")
        pos = decode_attr(gltf, blob, "POSITION", 3)
        xs, ys, zs = pos[:, 0], pos[:, 1], pos[:, 2]
        grid = source_grid("tile_2_3")
        for (c, r) in ((0, 0), (200, 0), (0, 200), (200, 200), (100, 100)):
            k = r * 201 + c
            lx = grid["x0"] + c * grid["dx"]
            lz = grid["z0"] + r * grid["dz"]
            self.assertAlmostEqual(float(xs[k]), lx, places=4)
            self.assertAlmostEqual(float(zs[k]), -lz, places=4)
            self.assertAlmostEqual(float(ys[k]), grid["heights"][k] - config["verticalDatum"], places=4)
        worst = max(abs(float(y) - (h - config["verticalDatum"])) for y, h in zip(ys, grid["heights"]))
        self.assertLess(worst, 1e-3)

    def test_north_uv_maps_to_atlas_top(self) -> None:
        """North-up UVs into the shared atlas: north edge v=0, south edge v=1."""
        out = build_tmp(self)
        gltf, blob = load_leaf(out, "tile_2_3")
        uv = decode_attr(gltf, blob, "TEXCOORD_0", 2)
        us, vs = uv[:, 0], uv[:, 1]
        self.assertTrue(bool(((us >= 0.0) & (us <= 1.0)).all()))
        self.assertTrue(bool(((vs >= 0.0) & (vs <= 1.0)).all()))
        grid = source_grid("tile_2_3")
        self.assertAlmostEqual(float(vs[0]), 1.0 - (grid["z0"] / 6000.0), places=6)
        self.assertAlmostEqual(float(vs[200 * 201]), 1.0 - ((grid["z0"] + 1000.0) / 6000.0), places=6)
        # Overview shares the same convention at the map corners.
        gltf_o, blob_o = parse_glb(out / OVERVIEW_URI)
        uv_o = decode_attr(gltf_o, blob_o, "TEXCOORD_0", 2)
        self.assertAlmostEqual(float(uv_o[0, 0]), 0.0, places=6)
        self.assertAlmostEqual(float(uv_o[0, 1]), 1.0, places=6)
        self.assertAlmostEqual(float(uv_o[-1, 0]), 1.0, places=6)
        self.assertAlmostEqual(float(uv_o[-1, 1]), 0.0, places=6)

    def test_overview_lod_error_matches_mdt(self) -> None:
        """Root REPLACE content is a 40 m overview; error measured vs MDT05."""
        out = build_tmp(self)
        tileset = json.loads((out / "tileset.json").read_text(encoding="utf-8"))
        manifest = json.loads((out / "manifest.json").read_text(encoding="utf-8"))
        root = tileset["root"]
        self.assertEqual(root.get("refine"), "REPLACE")
        self.assertEqual(root.get("content", {}).get("uri"), OVERVIEW_URI)
        self.assertTrue((out / OVERVIEW_URI).exists())
        gltf, blob = parse_glb(out / OVERVIEW_URI)
        pos = decode_attr(gltf, blob, "POSITION", 3)
        self.assertEqual(len(pos), OVERVIEW_NODES * OVERVIEW_NODES)
        expected, _ = overview_error_from_data()
        self.assertGreater(expected, 0.0)
        self.assertAlmostEqual(float(root["geometricError"]), expected, places=3)
        self.assertAlmostEqual(float(tileset["geometricError"]), expected, places=3)
        self.assertAlmostEqual(float(manifest["geometricError"]["root"]), expected, places=3)
        self.assertEqual(manifest["geometricError"]["leaf"], 0.0)
        # The LOD error is a simplification error, strictly below full relief.
        relief = manifest["heightRangeAbsoluteM"][1] - manifest["heightRangeAbsoluteM"][0]
        self.assertLess(float(root["geometricError"]), relief)
        for child in root["children"]:
            self.assertEqual(child.get("geometricError"), 0.0)
            self.assertTrue(str(child["content"]["uri"]).endswith(".glb"))

    def test_glb_payload_is_binary_with_external_pnoa(self) -> None:
        """GLB 2.0 containers, valid chunk offsets, uint16 indices, no pixels."""
        out = build_tmp(self)
        targets = [f"tiles/{tid}.glb" for tid in TILE_IDS] + [OVERVIEW_URI]
        counts = {tid: N * N for tid in TILE_IDS}
        for rel in targets:
            raw = (out / rel).read_bytes()
            gltf, blob = parse_glb(out / rel)
            self.assertEqual(gltf["asset"]["version"], "2.0")
            self.assertNotIn("data:", json.dumps(gltf))
            images = gltf.get("images", [])
            self.assertEqual(len(images), 1, rel)
            self.assertEqual(images[0]["uri"], ORTHOPHOTO_URI, rel)
            self.assertEqual(images[0]["mimeType"], "image/jpeg", rel)
            self.assertNotIn("buffers", json.dumps(images))
            buffers = gltf["buffers"]
            self.assertEqual(len(buffers), 1, rel)
            self.assertNotIn("uri", buffers[0], rel)
            self.assertEqual(buffers[0]["byteLength"], len(blob), rel)
            total_view = sum(v["byteLength"] for v in gltf["bufferViews"])
            self.assertEqual(total_view, len(blob), rel)
            for view in gltf["bufferViews"]:
                self.assertLess(view["byteOffset"] + view["byteLength"], len(blob) + 1, rel)
            mesh = gltf["meshes"][0]["primitives"][0]
            self.assertEqual(mesh["material"], 0, rel)
            self.assertEqual(mesh["mode"], 4, rel)
            mat = gltf["materials"][0]["pbrMetallicRoughness"]
            self.assertEqual(mat["baseColorTexture"]["index"], 0, rel)
            self.assertEqual(gltf["textures"][0]["source"], 0, rel)
            idx = decode_attr(gltf, blob, "INDICES", 1)
            vcount = len(decode_attr(gltf, blob, "POSITION", 3))
            self.assertLess(int(idx.max()), 65535, rel)
            self.assertTrue(bool((idx >= 0).all()), rel)
            self.assertTrue(bool((idx < vcount).all()), rel)
            stem = Path(rel).stem
            if stem in counts:
                self.assertEqual(vcount, counts[stem], rel)
            else:
                self.assertEqual(vcount, OVERVIEW_NODES * OVERVIEW_NODES, rel)
        self.assertTrue((PROJECT_ROOT / "public" / "terrain" / "3d-tiles" / "tiles" / "orthophoto.jpg").exists())

    def test_orthophoto_reference_is_external(self) -> None:
        """PNOA atlas is an EXTERNAL image URI; no pixels embedded in GLB."""
        out = build_tmp(self)
        for tid in TILE_IDS:
            gltf, _ = load_leaf(out, tid)
            images = gltf.get("images", [])
            self.assertEqual(len(images), 1, tid)
            uri = images[0]["uri"]
            self.assertEqual(uri, ORTHOPHOTO_URI, tid)
            self.assertFalse(uri.startswith("data:"), tid)
            self.assertEqual(images[0]["mimeType"], "image/jpeg", tid)
        gltf_o, _ = parse_glb(out / OVERVIEW_URI)
        self.assertEqual(gltf_o["images"][0]["uri"], ORTHOPHOTO_URI)
        self.assertTrue((PROJECT_ROOT / "public" / "terrain" / "3d-tiles" / "tiles" / "orthophoto.jpg").exists())

    def test_check_mode_is_deterministic(self) -> None:
        """Two derivations produce identical bytes/hashes (stable --check)."""
        first = Path(self._tmp_dir) / "a"
        second = Path(self._tmp_dir) / "b"
        manifest_a = builder.build_tileset(first)
        manifest_b = builder.build_tileset(second)
        self.assertEqual(manifest_a["outputs"], manifest_b["outputs"])
        for rel, digest in manifest_a["outputs"].items():
            a = (first / rel).read_bytes()
            b = (second / rel).read_bytes()
            self.assertEqual(a, b, rel)
            self.assertEqual(digest, manifest_b["outputs"][rel], rel)


if __name__ == "__main__":
    unittest.main()
