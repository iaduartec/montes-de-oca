#!/usr/bin/env python3
"""Validate the deterministic 3D Tiles terrain built by build_3d_tiles.py.

Fails nonzero on: missing tiles, invalid bounds/CRS/origin/datum, wrong PNOA
path or embedded pixels, invalid 3D Tiles 1.0 REPLACE hierarchy, missing or
fabricated overview LOD, overview error drifting from the MDT05 measurement,
invalid GLB chunks/offsets/hierarchy, seam height/normal mismatch, hash drift
against manifest.json, or absent attribution.

Usage:
    python3 scripts/terrain/validate_3d_tiles.py [--dir public/terrain/3d-tiles]
"""
from __future__ import annotations

import argparse
import hashlib
import json
import struct
import sys
from pathlib import Path

import numpy as np

PROJECT_ROOT = Path(__file__).resolve().parents[2]
PUBLIC_TERRAIN = PROJECT_ROOT / "public" / "terrain"

CRS = "EPSG:25830"
ORIGIN_E = 471500.0
ORIGIN_N = 4689000.0
SIDE_M = 6000.0
TILE_SIZE_M = 1000.0
TILES_PER_SIDE = 6
VERTICAL_DATUM = 870.0
VERTEX_COUNT = 201 * 201
INDEX_COUNT = 200 * 200 * 6
OVERVIEW_URI = "tiles/overview.glb"
OVERVIEW_NODES = 151
OVERVIEW_VERTEX_COUNT = OVERVIEW_NODES * OVERVIEW_NODES
OVERVIEW_INDEX_COUNT = (OVERVIEW_NODES - 1) * (OVERVIEW_NODES - 1) * 6
OVERVIEW_SAMPLING_M = 40.0
ORTHOPHOTO_URI = "../../orthophoto.webp"

TILE_IDS = [f"tile_{ix}_{iz}" for iz in range(TILES_PER_SIDE) for ix in range(TILES_PER_SIDE)]


class Failure(Exception):
    pass


def fail(message: str) -> None:
    raise Failure(message)


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def parse_glb(path: Path, label: str) -> tuple[dict, bytes]:
    raw = path.read_bytes()
    if len(raw) < 28:
        fail(f"{label}: GLB too short")
    magic, version, total = struct.unpack_from("<III", raw, 0)
    if magic != 0x46546C67:
        fail(f"{label}: bad GLB magic")
    if version != 2:
        fail(f"{label}: GLB version must be 2")
    if total != len(raw):
        fail(f"{label}: GLB total length mismatch")
    json_len, json_type = struct.unpack_from("<II", raw, 12)
    if json_type != 0x4E4F534A:
        fail(f"{label}: first chunk must be JSON")
    if 20 + json_len + 8 > len(raw):
        fail(f"{label}: truncated GLB chunks")
    try:
        gltf = json.loads(raw[20:20 + json_len].decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        fail(f"{label}: invalid GLB JSON chunk")
    cursor = 20 + json_len
    bin_len, bin_type = struct.unpack_from("<II", raw, cursor)
    if bin_type != 0x004E4942:
        fail(f"{label}: second chunk must be BIN")
    blob = raw[cursor + 8:cursor + 8 + bin_len]
    if len(blob) != bin_len:
        fail(f"{label}: BIN chunk truncated")
    if cursor + 8 + bin_len != len(raw):
        fail(f"{label}: trailing bytes after BIN chunk")
    return gltf, blob


def decode_floats(gltf: dict, blob: bytes, name: str, components: int, label: str) -> np.ndarray:
    mesh = gltf["meshes"][0]["primitives"][0]
    accessor = gltf["accessors"][mesh["attributes"][name]]
    view = gltf["bufferViews"][accessor["bufferView"]]
    if view["byteOffset"] + view["byteLength"] > len(blob):
        fail(f"{label}: {name} view outside BIN")
    start = view.get("byteOffset", 0) + accessor.get("byteOffset", 0)
    count = accessor["count"]
    if accessor["componentType"] != 5126:
        fail(f"{label}: {name} must be float32")
    nbytes = count * components * 4
    if start + nbytes > len(blob):
        fail(f"{label}: {name} accessor outside BIN")
    return np.frombuffer(blob[start:start + nbytes], dtype=np.float32).copy().reshape(count, components)


def decode_indices(gltf: dict, blob: bytes, label: str) -> np.ndarray:
    mesh = gltf["meshes"][0]["primitives"][0]
    accessor = gltf["accessors"][mesh["indices"]]
    view = gltf["bufferViews"][accessor["bufferView"]]
    if view["byteOffset"] + view["byteLength"] > len(blob):
        fail(f"{label}: INDICES view outside BIN")
    start = view.get("byteOffset", 0) + accessor.get("byteOffset", 0)
    count = accessor["count"]
    if accessor["componentType"] != 5123:
        fail(f"{label}: INDICES must be uint16")
    nbytes = count * 2
    if start + nbytes > len(blob):
        fail(f"{label}: INDICES accessor outside BIN")
    return np.frombuffer(blob[start:start + nbytes], dtype=np.uint16).copy()


def global_mdt_heights() -> np.ndarray:
    size = TILES_PER_SIDE * 200 + 1
    full = np.empty((size, size), dtype=np.float64)
    for iz in range(TILES_PER_SIDE):
        for ix in range(TILES_PER_SIDE):
            grid = json.loads((PUBLIC_TERRAIN / "tiles" / f"tile_{ix}_{iz}.json").read_text(encoding="utf-8"))["grid"]
            local = np.array(grid["heights"], dtype=np.float64).reshape(201, 201)
            full[iz * 200:iz * 200 + 201, ix * 200:ix * 200 + 201] = local
    return full


def measured_overview_error(global_heights: np.ndarray, overview: np.ndarray) -> float:
    size = global_heights.shape[0]
    step = 8
    n = OVERVIEW_NODES
    gx = np.arange(size)
    gz = np.arange(size)
    c0 = np.minimum(gx // step, n - 2)
    r0 = np.minimum(gz // step, n - 2)
    tx = (gx - c0 * step) / step
    tz = (gz - r0 * step) / step
    sw = overview[r0[:, None], c0[None, :]]
    se = overview[r0[:, None], c0[None, :] + 1]
    nw = overview[r0[:, None] + 1, c0[None, :]]
    ne = overview[r0[:, None] + 1, c0[None, :] + 1]
    lower = sw * (1 - tx[None, :]) + se * (tx[None, :] - tz[:, None]) + ne * tz[:, None]
    upper = sw * (1 - tz[:, None]) + ne * tx[None, :] + nw * (tz[:, None] - tx[None, :])
    interp = np.where(tx[None, :] >= tz[:, None], lower, upper)
    return float(np.abs(global_heights - interp).max())


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dir", type=Path, default=PUBLIC_TERRAIN / "3d-tiles")
    args = parser.parse_args()
    out = Path(args.dir)
    try:
        run(out)
    except Failure as exc:
        print(f"[tiles:fail] {exc}", file=sys.stderr)
        return 1
    print("[tiles:ok] 37 GLB contents validate: LOD/error/REPLACE/seams/normals/winding/PNOA/hashes/attribution")
    return 0


def run(out: Path) -> None:
    tileset_path = out / "tileset.json"
    manifest_path = out / "manifest.json"
    if not tileset_path.exists():
        fail("tileset.json missing")
    if not manifest_path.exists():
        fail("manifest.json missing")
    tileset = json.loads(tileset_path.read_text(encoding="utf-8"))
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))

    config = json.loads((PUBLIC_TERRAIN / "config.json").read_text(encoding="utf-8"))
    if config.get("crs") != CRS:
        fail(f"config crs {config.get('crs')!r}")
    if config.get("verticalDatum") != VERTICAL_DATUM:
        fail(f"config verticalDatum {config.get('verticalDatum')!r}")
    if list(config["bounds"]["e"]) != [ORIGIN_E, ORIGIN_E + SIDE_M]:
        fail("config bounds.e drifted")
    if list(config["bounds"]["n"]) != [ORIGIN_N, ORIGIN_N + SIDE_M]:
        fail("config bounds.n drifted")
    if manifest.get("verticalDatum") != VERTICAL_DATUM or manifest.get("crs") != CRS:
        fail("manifest datum/crs drifted")
    if manifest.get("tileCount") != 36:
        fail("manifest tileCount != 36")
    if manifest.get("overviewUri") != OVERVIEW_URI:
        fail("manifest overviewUri must be tiles/overview.glb")
    if manifest.get("overviewSamplingM") != OVERVIEW_SAMPLING_M:
        fail("manifest overviewSamplingM must be 40")
    if manifest.get("overviewNodesPerSide") != OVERVIEW_NODES:
        fail("manifest overviewNodesPerSide must be 151")

    # --- 3D Tiles 1.0 REPLACE hierarchy ------------------------------------
    if tileset.get("asset", {}).get("version") != "1.0":
        fail("tileset asset.version must be '1.0'")
    root = tileset.get("root")
    if not isinstance(root, dict):
        fail("root missing")
    if root.get("refine") != "REPLACE":
        fail("root refine must be REPLACE (overview refined by leaves)")
    if root.get("content", {}).get("uri") != OVERVIEW_URI:
        fail("root content must be the coarse overview GLB (far-view fallback)")
    children = root.get("children", [])
    if len(children) != 36:
        fail(f"root must have 36 children, got {len(children)}")
    root_error = root.get("geometricError")
    if not isinstance(root_error, (int, float)) or not root_error > 0:
        fail("root geometricError must be the measured positive LOD error")
    if tileset.get("geometricError") != root_error:
        fail("tileset geometricError must match root")
    if abs(float(manifest["geometricError"]["root"]) - float(root_error)) > 1e-6:
        fail("manifest geometricError.root drifts from tileset root")
    if manifest["geometricError"]["leaf"] != 0.0:
        fail("manifest geometricError.leaf must be 0")
    box = root.get("boundingVolume", {}).get("box")
    if not isinstance(box, list) or len(box) != 12:
        fail("root boundingVolume.box must hold 12 numbers")
    for got, want in ((box[0], 3000.0), (box[2], -3000.0), (box[3], 3000.0), (box[11], 3000.0)):
        if abs(got - want) > 1e-6:
            fail(f"root box does not cover the 6 km map in RH coords: {box}")
    if abs((box[1] + box[7]) - (manifest["heightRangeAbsoluteM"][1] - VERTICAL_DATUM)) > 1e-3:
        fail("root box top disagrees with manifest height range")
    if abs((box[1] - box[7]) - (manifest["heightRangeAbsoluteM"][0] - VERTICAL_DATUM)) > 1e-3:
        fail("root box bottom disagrees with manifest height range")

    # --- Overview LOD measured against MDT05 --------------------------------
    overview_path = out / OVERVIEW_URI
    if not overview_path.exists():
        fail(f"missing overview content {OVERVIEW_URI}")
    ov_heights_grid, _ = check_content(out, OVERVIEW_URI, "overview", box, expect_overview=True)
    global_heights = global_mdt_heights()
    sampled = global_heights[::8, ::8]
    if sampled.shape != (OVERVIEW_NODES, OVERVIEW_NODES):
        fail("global MDT stitch has the wrong shape")
    ov_abs = np.array(ov_heights_grid, dtype=np.float64) + VERTICAL_DATUM
    if float(np.abs(ov_abs - sampled).max()) > 1e-3:
        fail("overview vertices are not the 40 m MDT05 samples (fabricated relief?)")
    expected_error = measured_overview_error(global_heights, sampled)
    if expected_error <= 0:
        fail("measured overview error must be positive")
    if abs(float(root_error) - expected_error) > 1e-3:
        fail(f"root geometricError {root_error} != measured MDT deviation {expected_error}")
    relief = manifest["heightRangeAbsoluteM"][1] - manifest["heightRangeAbsoluteM"][0]
    if not float(root_error) < relief:
        fail("root LOD error must be below the full relief")

    seen = set()
    heights_by_tile: dict[str, list[list[float]]] = {}
    normals_by_tile: dict[str, np.ndarray] = {}
    for child in children:
        uri = child.get("content", {}).get("uri", "")
        tile_id = Path(uri).stem
        if tile_id in seen:
            fail(f"duplicate content {tile_id}")
        seen.add(tile_id)
        if tile_id not in TILE_IDS:
            fail(f"unexpected content id {tile_id}")
        if not uri.endswith(".glb"):
            fail(f"{tile_id}: leaf content must be binary .glb")
        if child.get("geometricError") != 0.0:
            fail(f"{tile_id}: leaf geometricError must be 0 (full resolution)")
        content_path = out / uri
        if not content_path.exists():
            fail(f"missing content file {uri}")
        cbox = child.get("boundingVolume", {}).get("box")
        if not isinstance(cbox, list) or len(cbox) != 12:
            fail(f"{tile_id}: leaf box must hold 12 numbers")
        ix = int(tile_id.split("_")[1])
        iz = int(tile_id.split("_")[2])
        if abs(cbox[0] - (ix * TILE_SIZE_M + 500.0)) > 1e-6:
            fail(f"{tile_id}: leaf box cx mismatch")
        if abs(cbox[2] - (-(iz * TILE_SIZE_M + 500.0))) > 1e-6:
            fail(f"{tile_id}: leaf box cz mismatch (RH frame)")
        if abs(cbox[3] - 500.0) > 1e-6 or abs(cbox[11] - 500.0) > 1e-6:
            fail(f"{tile_id}: leaf box half-extents must be 500 m")
        heights, normals = check_content(out, uri, tile_id, cbox, expect_overview=False)
        heights_by_tile[tile_id] = heights
        normals_by_tile[tile_id] = normals
    if seen != set(TILE_IDS):
        fail(f"children ids {sorted(seen)} != 6x6 extent")

    # --- Seams: heights identical, normals continuous -----------------------
    for iz in range(TILES_PER_SIDE):
        for ix in range(TILES_PER_SIDE):
            base = heights_by_tile[f"tile_{ix}_{iz}"]
            base_n = normals_by_tile[f"tile_{ix}_{iz}"]
            if ix < 5:
                east = [base[r][200] for r in range(201)]
                west = [heights_by_tile[f"tile_{ix + 1}_{iz}"][r][0] for r in range(201)]
                if east != west:
                    fail(f"seam E/W tile_{ix}_{iz}")
                if float(np.abs(base_n[:, 200, :] - normals_by_tile[f"tile_{ix + 1}_{iz}"][:, 0, :]).max()) > 1e-6:
                    fail(f"seam normals E/W tile_{ix}_{iz}")
            if iz < 5:
                if base[200] != heights_by_tile[f"tile_{ix}_{iz + 1}"][0]:
                    fail(f"seam N/S tile_{ix}_{iz}")
                if float(np.abs(base_n[200, :, :] - normals_by_tile[f"tile_{ix}_{iz + 1}"][0, :, :]).max()) > 1e-6:
                    fail(f"seam normals N/S tile_{ix}_{iz}")

    # --- Hashes vs manifest -------------------------------------------------
    for rel, digest in manifest.get("outputs", {}).items():
        path = out / rel
        if not path.exists():
            fail(f"manifest output missing: {rel}")
        if sha256_file(path) != digest:
            fail(f"hash drift in {rel}")
    for entry in manifest.get("tiles", []):
        path = out / entry["uri"]
        if sha256_file(path) != entry["sha256"]:
            fail(f"hash drift in {entry['id']}")
    if sha256_file(out / OVERVIEW_URI) != manifest.get("overview", {}).get("sha256", ""):
        fail("hash drift in overview.glb")

    # --- Attribution ---------------------------------------------------------
    attribution = (PUBLIC_TERRAIN / "ATTRIBUTION.md").read_text(encoding="utf-8")
    for marker in ("IGN", "CC BY 4.0", "PNOA", "3D Tiles"):
        if marker not in attribution:
            fail(f"ATTRIBUTION.md missing marker {marker!r}")


def check_content(
    out: Path, uri: str, tile_id: str, cbox: list[float], expect_overview: bool
) -> tuple[list[list[float]], np.ndarray]:
    path = out / uri
    label = tile_id
    gltf, blob = parse_glb(path, label)
    if gltf.get("asset", {}).get("version") != "2.0":
        fail(f"{label}: glTF asset.version must be 2.0")

    images = gltf.get("images", [])
    if len(images) != 1 or images[0].get("uri") != ORTHOPHOTO_URI:
        fail(f"{label}: PNOA image must be the external uri {ORTHOPHOTO_URI}")
    if images[0].get("mimeType") != "image/webp":
        fail(f"{label}: PNOA mimeType must be image/webp")
    if "data:" in json.dumps(gltf):
        fail(f"{label}: embedded bytes forbidden (GLB JSON must not use data: uris)")
    buffers = gltf.get("buffers", [])
    if len(buffers) != 1 or "uri" in buffers[0]:
        fail(f"{label}: GLB buffer must be the BIN chunk (no uri)")
    if buffers[0].get("byteLength") != len(blob):
        fail(f"{label}: buffer byteLength must match the BIN chunk")
    if sum(v.get("byteLength", 0) for v in gltf.get("bufferViews", [])) != len(blob):
        fail(f"{label}: bufferViews must tile the BIN chunk exactly")
    if not (PUBLIC_TERRAIN / "orthophoto.webp").exists():
        fail(f"{label}: referenced orthophoto.webp is missing")
    mesh = gltf["meshes"][0]["primitives"][0]
    if mesh.get("material") != 0 or mesh.get("mode") != 4:
        fail(f"{label}: mesh must keep the PBR TRIANGLES material link")
    if gltf["materials"][0]["pbrMetallicRoughness"]["baseColorTexture"]["index"] != 0:
        fail(f"{label}: PBR baseColorTexture link broken")
    if gltf["textures"][0]["source"] != 0:
        fail(f"{label}: texture source link broken")

    n_side = OVERVIEW_NODES if expect_overview else 201
    vcount = OVERVIEW_VERTEX_COUNT if expect_overview else VERTEX_COUNT
    icount = OVERVIEW_INDEX_COUNT if expect_overview else INDEX_COUNT
    pos = decode_floats(gltf, blob, "POSITION", 3, label)
    if len(pos) != vcount:
        fail(f"{label}: POSITION count {len(pos)} != {vcount}")
    nrm = decode_floats(gltf, blob, "NORMAL", 3, label)
    if len(nrm) != vcount:
        fail(f"{label}: NORMAL count mismatch")
    uv = decode_floats(gltf, blob, "TEXCOORD_0", 2, label)
    if len(uv) != vcount:
        fail(f"{label}: TEXCOORD_0 count mismatch")
    idx = decode_indices(gltf, blob, label)
    if len(idx) != icount:
        fail(f"{label}: INDICES count {len(idx)} != {icount}")
    if int(idx.max()) >= vcount or int(idx.min()) < 0:
        fail(f"{label}: indices outside [0, {vcount})")
    if int(idx.max()) >= 65535:
        fail(f"{label}: indices must stay valid uint16")

    xs, ys, zs = pos[:, 0], pos[:, 1], pos[:, 2]
    us, vs = uv[:, 0], uv[:, 1]
    nrm_2d = nrm.reshape(n_side, n_side, 3)

    if not expect_overview:
        grid = json.loads((PUBLIC_TERRAIN / "tiles" / f"{tile_id}.json").read_text(encoding="utf-8"))["grid"]
        heights = grid["heights"]
        worst = 0.0
        for k in range(vcount):
            c, r = k % 201, k // 201
            lx = grid["x0"] + c * grid["dx"]
            lz = grid["z0"] + r * grid["dz"]
            if abs(float(xs[k]) - lx) > 1e-3 or abs(float(zs[k]) + lz) > 1e-3:
                fail(f"{label}: vertex {k} not in RH frame (x, -z)")
            diff = abs(float(ys[k]) - (heights[k] - VERTICAL_DATUM))
            worst = max(worst, diff)
        if worst > 1e-3:
            fail(f"{label}: mesh/datum disagreement {worst} m > 1 mm")
        south_v = 1.0 - grid["z0"] / SIDE_M
        north_v = 1.0 - (grid["z0"] + TILE_SIZE_M) / SIDE_M
        if abs(float(vs[0]) - south_v) > 1e-6 or abs(float(vs[200 * 201]) - north_v) > 1e-6:
            fail(f"{label}: UVs are not north-up into the shared atlas")
    else:
        if float(xs.min()) < -1e-3 or float(xs.max()) - SIDE_M > 1e-3:
            fail(f"{label}: overview X outside the 6 km window")
        if float(zs.min()) + SIDE_M < -1e-3 or float(zs.max()) > 1e-3:
            fail(f"{label}: overview Z outside the RH window")
        if abs(float(us[0]) - 0.0) > 1e-6 or abs(float(vs[0]) - 1.0) > 1e-6:
            fail(f"{label}: overview SW UV must be (0, 1)")
        if abs(float(us[-1]) - 1.0) > 1e-6 or abs(float(vs[-1]) - 0.0) > 1e-6:
            fail(f"{label}: overview NE UV must be (1, 0)")

    # Boxes must contain the realised content Y range (exact for full-res
    # leaves; containment for the decimated overview whose samples bound
    # the relief from inside).
    ymin, ymax = float(ys.min()), float(ys.max())
    if expect_overview:
        if cbox[1] - cbox[7] > ymin + 1e-3 or cbox[1] + cbox[7] < ymax - 1e-3:
            fail(f"{label}: box does not contain the overview Y range")
    elif abs(cbox[1] - (ymin + ymax) / 2.0) > 1e-3 or abs(cbox[7] - (ymax - ymin) / 2.0) > 1e-3:
        fail(f"{label}: box disagrees with content Y range")

    # North-up atlas mapping: u/v inside [0,1].
    if float(us.min()) < 0.0 or float(us.max()) > 1.0 or float(vs.min()) < 0.0 or float(vs.max()) > 1.0:
        fail(f"{label}: UVs outside [0,1]")

    # Outward winding/normals: first cell keeps SW->NE, faces point +Y.
    if idx[:6].tolist() != [0, 1, n_side + 1, 0, n_side + 1, n_side]:
        fail(f"{label}: first cell must keep the SW->NE split")
    if bool((nrm[:, 1] <= 0.0).any()):
        fail(f"{label}: normals must face outward (+Y)")
    if float(np.abs(np.linalg.norm(nrm, axis=1) - 1.0).max()) > 1e-3:
        fail(f"{label}: normals must be unit length")
    pa, pb, pc = pos[int(idx[0])], pos[int(idx[1])], pos[int(idx[2])]
    face = np.cross(pb - pa, pc - pa)
    if float(face[1]) <= 0.0:
        fail(f"{label}: triangles must wind CCW-up in the RH frame")

    grid_rows = [ys[r * n_side:(r + 1) * n_side].tolist() for r in range(n_side)]
    return grid_rows, nrm_2d


if __name__ == "__main__":
    raise SystemExit(main())
