#!/usr/bin/env python3
"""Deterministic offline 3D Tiles builder from the existing MDT05 heightfield.

Reads the 36 published heightfield tiles (`public/terrain/tiles/*.json`) plus
`public/terrain/config.json` and writes a two-level 3D Tiles 1.0 tileset:

    public/terrain/3d-tiles/tileset.json
    public/terrain/3d-tiles/tiles/overview.glb   (6 km coarse LOD, 40 m)
    public/terrain/3d-tiles/tiles/tile_<ix>_<iz>.glb   (36 leaves, 5 m)
    public/terrain/3d-tiles/manifest.json

Conventions (fixed, shared with the runtime):
  * Logical frame: EPSG:25830, world origin E=471500/N=4689000, X east,
    logical Z north, heights absolute metres, worldScale = 1.
  * Mesh vertices are stored in Babylon RIGHT-HANDED world coordinates:
    (logical x, logical height - verticalDatum, -logical z).
  * UVs map into the shared north-up PNOA atlas (`orthophoto.webp`, image
    row 0 = north edge). glTF UV origin is top-left, so v = 1 - z/6000.
    The image is referenced EXTERNALLY; no pixel bytes are embedded.
  * Triangles keep the SW->NE split of the authoritative heightfield sampler
    (`src/heightfield.ts`), re-wound for the RH frame so faces point up.
  * OSM building geometry is NOT baked into the tiles: buildings stay a
    separate runtime layer that preserves the existing footprints/heights.
  * LOD: REPLACE hierarchy. The root carries a real 40 m overview sampled
    from the existing MDT05 tiles (no fabricated relief, no third-party
    data); its geometricError is the measured maximum vertical deviation of
    the triangulated overview surface against every 5 m MDT sample. The 36
    children are the full-resolution 1 km / 5 m leaves (geometricError 0)
    that refine the overview. A far aerial view always has content
    (the overview) while leaves stream in.
  * Normals on shared leaf edges are computed from the stitched global
    heightfield (central differences across the seam), so exact-height
    border vertices have equal normalized normals. Only the outer world
    border uses one-sided differences.
  * Geometry payloads are self-contained binary GLB 2.0 (JSON + BIN
    chunks); the PNOA webp stays an external URI. All indices fit uint16.

Determinism: sorted keys, compact separators, no timestamps, no absolute
paths, no network access. `build_3d_tiles.py --check` rebuilds into a
temporary directory and byte-compares against the public outputs.

Usage:
    python3 scripts/terrain/build_3d_tiles.py [--out-dir DIR] [--check]
"""
from __future__ import annotations

import argparse
import hashlib
import json
import struct
import sys
import tempfile
from pathlib import Path

import numpy as np

PROJECT_ROOT = Path(__file__).resolve().parents[2]
PUBLIC_TERRAIN = PROJECT_ROOT / "public" / "terrain"
SOURCE_TILES = PUBLIC_TERRAIN / "tiles"
CONFIG_PATH = PUBLIC_TERRAIN / "config.json"
DEFAULT_OUT = PUBLIC_TERRAIN / "3d-tiles"

# Fixed world convention (must match public/terrain/config.json).
CRS = "EPSG:25830"
ORIGIN_E = 471500.0
ORIGIN_N = 4689000.0
SIDE_M = 6000.0
TILE_SIZE_M = 1000.0
TILES_PER_SIDE = 6
SAMPLING_M = 5.0
NODES_PER_SIDE = 201
VERTEX_COUNT = NODES_PER_SIDE * NODES_PER_SIDE  # 40401
INDEX_COUNT = (NODES_PER_SIDE - 1) * (NODES_PER_SIDE - 1) * 6  # 240000
VERTICAL_DATUM = 870.0
WORLD_SCALE = 1

# Coarse root LOD sampled from the same MDT05 tiles (40 m = 8 x 5 m).
OVERVIEW_SAMPLING_M = 40.0
OVERVIEW_STEP_SAMPLES = 8
OVERVIEW_NODES_PER_SIDE = 150 + 1  # 6000/40 + 1 = 151
OVERVIEW_VERTEX_COUNT = OVERVIEW_NODES_PER_SIDE * OVERVIEW_NODES_PER_SIDE
OVERVIEW_INDEX_COUNT = (OVERVIEW_NODES_PER_SIDE - 1) * (OVERVIEW_NODES_PER_SIDE - 1) * 6
OVERVIEW_ID = "overview"
OVERVIEW_URI = f"tiles/{OVERVIEW_ID}.glb"
GLOBAL_NODES_PER_SIDE = TILES_PER_SIDE * (NODES_PER_SIDE - 1) + 1  # 1201

# Content lives in <out>/tiles/; the atlas lives at /terrain/orthophoto.webp.
ORTHOPHOTO_URI = "../../orthophoto.webp"
ORTHOPHOTO_PUBLIC_URL = "/terrain/orthophoto.webp"

TILE_IDS = [f"tile_{ix}_{iz}" for iz in range(TILES_PER_SIDE) for ix in range(TILES_PER_SIDE)]

GENERATOR = "scripts/terrain/build_3d_tiles.py"


# --------------------------------------------------------------------------- #
def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def dump_json(payload: object) -> str:
    return json.dumps(payload, sort_keys=True, separators=(",", ":")) + "\n"


def load_config() -> dict:
    config = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    if config.get("crs") != CRS:
        raise SystemExit(f"config crs {config.get('crs')!r} != {CRS}")
    if config.get("verticalDatum") != VERTICAL_DATUM:
        raise SystemExit(f"config verticalDatum {config.get('verticalDatum')!r} != {VERTICAL_DATUM}")
    if config.get("worldScale") != WORLD_SCALE:
        raise SystemExit("config worldScale must be 1")
    bounds = config.get("bounds", {})
    if list(bounds.get("e", [])) != [ORIGIN_E, ORIGIN_E + SIDE_M]:
        raise SystemExit(f"config bounds.e {bounds.get('e')!r} is not the 6 km window")
    if list(bounds.get("n", [])) != [ORIGIN_N, ORIGIN_N + SIDE_M]:
        raise SystemExit(f"config bounds.n {bounds.get('n')!r} is not the 6 km window")
    ids = [t["id"] for t in config.get("tiles", [])]
    if sorted(ids) != sorted(TILE_IDS):
        raise SystemExit("config tiles are not the expected 36 ids")
    return config


def load_source_grid(tile_id: str) -> dict:
    raw = json.loads((SOURCE_TILES / f"{tile_id}.json").read_text(encoding="utf-8"))
    if raw.get("schemaVersion") != 1 or raw.get("id") != tile_id:
        raise SystemExit(f"{tile_id}: bad schema/id")
    grid = raw["grid"]
    ix = int(tile_id.split("_")[1])
    iz = int(tile_id.split("_")[2])
    expected = {
        "x0": ix * TILE_SIZE_M,
        "z0": iz * TILE_SIZE_M,
        "dx": SAMPLING_M,
        "dz": SAMPLING_M,
        "columns": NODES_PER_SIDE,
        "rows": NODES_PER_SIDE,
    }
    for key, value in expected.items():
        if grid.get(key) != value:
            raise SystemExit(f"{tile_id}: grid.{key}={grid.get(key)!r} != {value!r}")
    heights = grid["heights"]
    if len(heights) != VERTEX_COUNT or not all(isinstance(h, (int, float)) for h in heights):
        raise SystemExit(f"{tile_id}: heights must hold {VERTEX_COUNT} numbers")
    return grid


def build_global_heights(grids: dict[str, dict]) -> np.ndarray:
    """Stitch the 36 tiles into one 1201x1201 absolute-height grid."""
    size = GLOBAL_NODES_PER_SIDE
    full = np.empty((size, size), dtype=np.float64)
    for iz in range(TILES_PER_SIDE):
        for ix in range(TILES_PER_SIDE):
            local = np.array(grids[f"tile_{ix}_{iz}"]["heights"], dtype=np.float64).reshape(
                NODES_PER_SIDE, NODES_PER_SIDE
            )
            full[iz * 200:iz * 200 + NODES_PER_SIDE, ix * 200:ix * 200 + NODES_PER_SIDE] = local
    return full


def heightfield_gradients(heights: np.ndarray, spacing: float) -> tuple[np.ndarray, np.ndarray]:
    """Central differences inside, one-sided at the outer border only."""
    dhdx = np.empty_like(heights)
    dhdz = np.empty_like(heights)
    dhdx[:, 0] = (heights[:, 1] - heights[:, 0]) / spacing
    dhdx[:, -1] = (heights[:, -1] - heights[:, -2]) / spacing
    dhdx[:, 1:-1] = (heights[:, 2:] - heights[:, :-2]) / (2.0 * spacing)
    dhdz[0, :] = (heights[1, :] - heights[0, :]) / spacing
    dhdz[-1, :] = (heights[-1, :] - heights[-2, :]) / spacing
    dhdz[1:-1, :] = (heights[2:, :] - heights[:-2, :]) / (2.0 * spacing)
    return dhdx, dhdz


def normals_from_gradients(dhdx: np.ndarray, dhdz: np.ndarray) -> np.ndarray:
    """Logical heightfield normals reflected to the RH frame (z negated)."""
    inv = 1.0 / np.sqrt(dhdx * dhdx + 1.0 + dhdz * dhdz)
    return np.stack([-dhdx * inv, inv, dhdz * inv], axis=-1).astype(np.float32)


def surface_arrays(
    grid: dict, dhdx_tile: np.ndarray, dhdz_tile: np.ndarray
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """Return render-space positions (N,3 float32), normals, uvs + heights grid."""
    heights = np.array(grid["heights"], dtype=np.float64).reshape(NODES_PER_SIDE, NODES_PER_SIDE)
    cols = np.arange(NODES_PER_SIDE, dtype=np.float64)
    rows = np.arange(NODES_PER_SIDE, dtype=np.float64)
    lx = grid["x0"] + cols * grid["dx"]  # logical x, east
    lz = grid["z0"] + rows * grid["dz"]  # logical z, north
    xx, zz = np.meshgrid(lx, lz)
    y = heights - VERTICAL_DATUM
    positions = np.stack([xx, y, -zz], axis=-1).astype(np.float32)

    normals = normals_from_gradients(dhdx_tile, dhdz_tile)

    # North-up atlas, glTF top-left UV origin: north edge (z=6000) -> v=0.
    u = (xx / SIDE_M).astype(np.float32)
    v = (1.0 - zz / SIDE_M).astype(np.float32)
    uvs = np.stack([u, v], axis=-1).astype(np.float32)
    return positions, normals, uvs, heights


def overview_arrays(
    overview_heights: np.ndarray,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Render-space positions/normals/uvs for the 40 m overview grid."""
    n = OVERVIEW_NODES_PER_SIDE
    axis = np.arange(n, dtype=np.float64) * OVERVIEW_SAMPLING_M
    xx, zz = np.meshgrid(axis, axis)
    y = overview_heights - VERTICAL_DATUM
    positions = np.stack([xx, y, -zz], axis=-1).astype(np.float32)
    dhdx, dhdz = heightfield_gradients(overview_heights, OVERVIEW_SAMPLING_M)
    normals = normals_from_gradients(dhdx, dhdz)
    u = (xx / SIDE_M).astype(np.float32)
    v = (1.0 - zz / SIDE_M).astype(np.float32)
    uvs = np.stack([u, v], axis=-1).astype(np.float32)
    return positions, normals, uvs


def overview_geometric_error(global_heights: np.ndarray, overview_heights: np.ndarray) -> float:
    """Max vertical deviation of matching SW->NE triangle surfaces at 5 m nodes."""
    size = GLOBAL_NODES_PER_SIDE
    step = OVERVIEW_STEP_SAMPLES
    n = OVERVIEW_NODES_PER_SIDE
    gx = np.arange(size)
    gz = np.arange(size)
    c0 = np.minimum(gx // step, n - 2)
    r0 = np.minimum(gz // step, n - 2)
    tx = (gx - c0 * step) / step
    tz = (gz - r0 * step) / step
    c0b = c0[None, :]
    r0b = r0[:, None]
    txb = tx[None, :]
    tzb = tz[:, None]
    sw = overview_heights[r0b, c0b]
    se = overview_heights[r0b, c0b + 1]
    nw = overview_heights[r0b + 1, c0b]
    ne = overview_heights[r0b + 1, c0b + 1]
    lower = sw * (1 - txb) + se * (txb - tzb) + ne * tzb
    upper = sw * (1 - tzb) + ne * txb + nw * (tzb - txb)
    interp = np.where(txb >= tzb, lower, upper)
    return float(np.abs(global_heights - interp).max())


def build_indices_n(n: int) -> np.ndarray:
    """RH CCW-up triangles preserving the sampler SW->NE cell split."""
    ii, jj = np.meshgrid(np.arange(n - 1), np.arange(n - 1))
    sw = (jj * n + ii).ravel()
    se = sw + 1
    nw = sw + n
    ne = nw + 1
    tris = np.empty((sw.size, 6), dtype=np.uint16)
    tris[:, 0] = sw
    tris[:, 1] = se
    tris[:, 2] = ne
    tris[:, 3] = sw
    tris[:, 4] = ne
    tris[:, 5] = nw
    if int(tris.max()) >= 65535:
        raise SystemExit("index overflow: mesh too large for uint16")
    return tris.ravel()


_INDICES = build_indices_n(NODES_PER_SIDE)
_OVERVIEW_INDICES = build_indices_n(OVERVIEW_NODES_PER_SIDE)


def pack_glb(
    tile_id: str,
    positions: np.ndarray,
    normals: np.ndarray,
    uvs: np.ndarray,
    indices: np.ndarray,
    vertex_count: int,
) -> bytes:
    """Pack one self-contained binary GLB 2.0 (JSON + BIN, external image)."""
    positions = np.ascontiguousarray(positions.reshape(vertex_count, 3), dtype=np.float32)
    normals = np.ascontiguousarray(normals.reshape(vertex_count, 3), dtype=np.float32)
    uvs = np.ascontiguousarray(uvs.reshape(vertex_count, 2), dtype=np.float32)
    indices = np.ascontiguousarray(indices.reshape(-1), dtype=np.uint16)
    if positions.shape != (vertex_count, 3):
        raise SystemExit(f"{tile_id}: bad POSITION array")
    if normals.shape != (vertex_count, 3) or normals.dtype != np.float32:
        raise SystemExit(f"{tile_id}: bad NORMAL array")
    if uvs.shape != (vertex_count, 2) or uvs.dtype != np.float32:
        raise SystemExit(f"{tile_id}: bad TEXCOORD array")
    if indices.dtype != np.uint16 or int(indices.max()) >= vertex_count:
        raise SystemExit(f"{tile_id}: invalid uint16 indices")
    pos_bytes = positions.tobytes()
    nrm_bytes = normals.tobytes()
    uv_bytes = uvs.tobytes()
    idx_bytes = indices.tobytes()
    blob = pos_bytes + nrm_bytes + uv_bytes + idx_bytes
    if len(blob) % 4 != 0:
        blob = blob + b"\x00" * (4 - len(blob) % 4)

    def fminmax(arr: np.ndarray) -> tuple[list[float], list[float]]:
        flat = arr.reshape(-1, arr.shape[-1])
        return [float(v) for v in flat.min(axis=0)], [float(v) for v in flat.max(axis=0)]

    pmin, pmax = fminmax(positions)
    nmin, nmax = fminmax(normals)
    umin, umax = fminmax(uvs)
    imin, imax = int(indices.min()), int(indices.max())

    views = []
    offset = 0
    for chunk, target in (
        (pos_bytes, 34962),
        (nrm_bytes, 34962),
        (uv_bytes, 34962),
        (idx_bytes, 34963),
    ):
        views.append({"buffer": 0, "byteOffset": offset, "byteLength": len(chunk), "target": target})
        offset += len(chunk)

    gltf = {
        "accessors": [
            {"bufferView": 0, "componentType": 5126, "count": vertex_count, "type": "VEC3", "min": pmin, "max": pmax},
            {"bufferView": 1, "componentType": 5126, "count": vertex_count, "type": "VEC3", "min": nmin, "max": nmax},
            {"bufferView": 2, "componentType": 5126, "count": vertex_count, "type": "VEC2", "min": umin, "max": umax},
            {"bufferView": 3, "componentType": 5123, "count": len(indices), "type": "SCALAR", "min": [imin], "max": [imax]},
        ],
        "asset": {"generator": GENERATOR, "version": "2.0"},
        "bufferViews": views,
        "buffers": [{"byteLength": len(blob)}],
        "images": [{"uri": ORTHOPHOTO_URI, "mimeType": "image/webp"}],
        "materials": [
            {
                "name": f"{tile_id}-pnoa",
                "pbrMetallicRoughness": {
                    "baseColorTexture": {"index": 0},
                    "metallicFactor": 0.0,
                    "roughnessFactor": 1.0,
                },
            }
        ],
        "meshes": [
            {
                "name": tile_id,
                "primitives": [
                    {
                        "attributes": {"POSITION": 0, "NORMAL": 1, "TEXCOORD_0": 2},
                        "indices": 3,
                        "material": 0,
                        "mode": 4,
                    }
                ],
            }
        ],
        "nodes": [{"mesh": 0, "name": tile_id}],
        "samplers": [{"magFilter": 9729, "minFilter": 9986, "wrapS": 33071, "wrapT": 33071}],
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "textures": [{"sampler": 0, "source": 0}],
    }
    json_bytes = dump_json(gltf).encode("utf-8")
    if len(json_bytes) % 4 != 0:
        json_bytes = json_bytes + b" " * (4 - len(json_bytes) % 4)
    total = 12 + 8 + len(json_bytes) + 8 + len(blob)
    header = struct.pack("<III", 0x46546C67, 2, total)
    json_header = struct.pack("<II", len(json_bytes), 0x4E4F534A)
    bin_header = struct.pack("<II", len(blob), 0x004E4942)
    return header + json_header + json_bytes + bin_header + blob


def axis_box(cx: float, cy: float, cz: float, hx: float, hy: float, hz: float) -> list[float]:
    return [cx, cy, cz, hx, 0.0, 0.0, 0.0, hy, 0.0, 0.0, 0.0, hz]


def build_tileset(out_dir: Path) -> dict:
    """Derive every artefact into out_dir. Returns the manifest dict."""
    load_config()  # fail fast on CRS/extent/datum drift
    out_dir = Path(out_dir)
    tiles_dir = out_dir / "tiles"
    tiles_dir.mkdir(parents=True, exist_ok=True)

    grids = {tile_id: load_source_grid(tile_id) for tile_id in TILE_IDS}
    global_heights = build_global_heights(grids)
    global_dhdx, global_dhdz = heightfield_gradients(global_heights, SAMPLING_M)

    tile_entries = []
    global_min = float(global_heights.min())
    global_max = float(global_heights.max())
    for tile_id in TILE_IDS:
        grid = grids[tile_id]
        ix = int(tile_id.split("_")[1])
        iz = int(tile_id.split("_")[2])
        dhdx_tile = global_dhdx[iz * 200:iz * 200 + NODES_PER_SIDE, ix * 200:ix * 200 + NODES_PER_SIDE]
        dhdz_tile = global_dhdz[iz * 200:iz * 200 + NODES_PER_SIDE, ix * 200:ix * 200 + NODES_PER_SIDE]
        positions, normals, uvs, heights = surface_arrays(grid, dhdx_tile, dhdz_tile)
        payload = pack_glb(tile_id, positions, normals, uvs, _INDICES, VERTEX_COUNT)
        (tiles_dir / f"{tile_id}.glb").write_bytes(payload)
        y_min = float(heights.min() - VERTICAL_DATUM)
        y_max = float(heights.max() - VERTICAL_DATUM)
        tile_entries.append(
            {
                "id": tile_id,
                "uri": f"tiles/{tile_id}.glb",
                "logicalBounds": {"x": [ix * TILE_SIZE_M, (ix + 1) * TILE_SIZE_M], "z": [iz * TILE_SIZE_M, (iz + 1) * TILE_SIZE_M]},
                "box": axis_box(
                    ix * TILE_SIZE_M + 500.0, (y_min + y_max) / 2.0, -(iz * TILE_SIZE_M + 500.0),
                    500.0, (y_max - y_min) / 2.0, 500.0,
                ),
                "yMin": y_min,
                "yMax": y_max,
            }
        )

    # Coarse root LOD: every 8th MDT sample (40 m), measured against MDT05.
    overview_heights = global_heights[::OVERVIEW_STEP_SAMPLES, ::OVERVIEW_STEP_SAMPLES]
    assert overview_heights.shape == (OVERVIEW_NODES_PER_SIDE, OVERVIEW_NODES_PER_SIDE)
    lod_error = overview_geometric_error(global_heights, overview_heights)
    ov_positions, ov_normals, ov_uvs = overview_arrays(overview_heights)
    overview_payload = pack_glb(OVERVIEW_ID, ov_positions, ov_normals, ov_uvs, _OVERVIEW_INDICES, OVERVIEW_VERTEX_COUNT)
    (tiles_dir / f"{OVERVIEW_ID}.glb").write_bytes(overview_payload)
    # Drop the legacy single-level JSON payloads so stale files never ship.
    for legacy in tiles_dir.glob("*.gltf"):
        legacy.unlink()

    relief = global_max - global_min
    root_cy = (global_min + global_max) / 2.0 - VERTICAL_DATUM
    root_box = axis_box(3000.0, root_cy, -3000.0, 3000.0, relief / 2.0, 3000.0)
    tileset = {
        "asset": {"version": "1.0", "tilesetVersion": f"{GENERATOR}@mdt05-5m"},
        "geometricError": lod_error,
        "root": {
            "boundingVolume": {"box": root_box},
            "geometricError": lod_error,
            "refine": "REPLACE",
            "content": {"uri": OVERVIEW_URI},
            "extras": {
                "crs": CRS,
                "originE": ORIGIN_E,
                "originN": ORIGIN_N,
                "frame": "Babylon RH: (x, h - 870, -z)",
                "note": "REPLACE LOD: 40 m overview content refined by 36 full-resolution 1 km leaves.",
                "overviewSamplingM": OVERVIEW_SAMPLING_M,
                "overviewNodesPerSide": OVERVIEW_NODES_PER_SIDE,
            },
            "children": [
                {
                    "boundingVolume": {"box": entry["box"]},
                    "geometricError": 0.0,
                    "content": {"uri": entry["uri"]},
                    "extras": {"id": entry["id"], "logicalBounds": entry["logicalBounds"]},
                }
                for entry in tile_entries
            ],
        },
    }
    (out_dir / "tileset.json").write_text(dump_json(tileset), encoding="utf-8")

    sources: dict[str, str] = {"terrain/config.json": sha256_bytes(CONFIG_PATH.read_bytes())}
    for tile_id in TILE_IDS:
        rel = f"terrain/tiles/{tile_id}.json"
        sources[rel] = sha256_bytes((PUBLIC_TERRAIN / "tiles" / f"{tile_id}.json").read_bytes())
    ortho_manifest = PUBLIC_TERRAIN / "orthophoto.json"
    sources["terrain/orthophoto.json"] = sha256_bytes(ortho_manifest.read_bytes())
    sources["terrain/orthophoto.webp"] = sha256_bytes((PUBLIC_TERRAIN / "orthophoto.webp").read_bytes())

    content_rels = [OVERVIEW_URI] + [e["uri"] for e in tile_entries]
    outputs: dict[str, str] = {}
    for rel in ["tileset.json", "manifest.json"] + content_rels:
        outputs[rel] = sha256_bytes((out_dir / rel).read_bytes()) if (out_dir / rel).exists() else ""

    manifest = {
        "schemaVersion": 1,
        "generator": GENERATOR,
        "crs": CRS,
        "originE": ORIGIN_E,
        "originN": ORIGIN_N,
        "sideM": SIDE_M,
        "tileSizeM": TILE_SIZE_M,
        "tilesPerSide": TILES_PER_SIDE,
        "tileCount": len(tile_entries),
        "samplingM": SAMPLING_M,
        "nodesPerSide": NODES_PER_SIDE,
        "overviewUri": OVERVIEW_URI,
        "overviewSamplingM": OVERVIEW_SAMPLING_M,
        "overviewNodesPerSide": OVERVIEW_NODES_PER_SIDE,
        "overviewVertexCount": OVERVIEW_VERTEX_COUNT,
        "verticalDatum": VERTICAL_DATUM,
        "worldScale": WORLD_SCALE,
        "frame": "Babylon RH world: X east, Y = absolute height - 870, Z = -logical-north",
        "uvConvention": "u = x/6000, v = 1 - z/6000 (glTF top-left UV origin; atlas row 0 = north edge)",
        "triangulation": "SW->NE cell split identical to src/heightfield.ts, re-wound for RH",
        "normals": (
            "Leaf shared-edge normals use central differences on the stitched global "
            "heightfield (both neighbours); only the outer world border is one-sided."
        ),
        "lod": (
            "Two-level REPLACE LOD. Root carries a real 40 m overview GLB sampled from "
            "the existing MDT05 tiles (no fabricated relief); its geometricError is the "
            "measured maximum vertical deviation of the triangulated overview surface against "
            "every 5 m MDT sample. The 36 children are full MDT05 5 m 1 km leaves with "
            "geometricError 0 that refine the overview for close views."
        ),
        "buildings": (
            "OSM building geometry is not baked into tile contents; buildings remain a "
            "separate runtime layer preserving existing footprints/heights (no fabricated detail)."
        ),
        "orthophoto": {
            "uri": ORTHOPHOTO_URI,
            "resolvesTo": ORTHOPHOTO_PUBLIC_URL,
            "mimeType": "image/webp",
            "note": "External reference only; no PNOA pixel bytes are embedded in any GLB.",
        },
        "geometricError": {"root": lod_error, "leaf": 0.0},
        "heightRangeAbsoluteM": [global_min, global_max],
        "overviewErrorM": lod_error,
        "sources": sources,
        "outputs": outputs,
        "tiles": [
            {**entry, "sha256": sha256_bytes((out_dir / entry["uri"]).read_bytes())}
            for entry in tile_entries
        ],
        "overview": {"uri": OVERVIEW_URI, "sha256": sha256_bytes((out_dir / OVERVIEW_URI).read_bytes())},
        "attribution": {
            "terrain": "Modelo Digital del Terreno (MDT05) © Instituto Geográfico Nacional (IGN-CNIG), CC BY 4.0.",
            "orthophoto": "Obra derivada de PNOA 2023-09 CC-BY 4.0 scne.es (IGN-CNIG).",
            "note": "Full text in public/terrain/ATTRIBUTION.md; keep it with any distribution.",
        },
    }
    outputs["manifest.json"] = ""  # placeholder replaced below
    manifest_text = dump_json({**manifest, "outputs": {k: v for k, v in outputs.items() if k != "manifest.json"}})
    # Hash the manifest without its own digest, then record sibling digests.
    manifest_digest = sha256_bytes(manifest_text.encode("utf-8"))
    manifest["outputs"] = {k: v for k, v in outputs.items() if k != "manifest.json"}
    manifest["manifestSha256"] = manifest_digest
    (out_dir / "manifest.json").write_text(dump_json(manifest), encoding="utf-8")
    return manifest


def check_against_public() -> int:
    """Rebuild into a temp dir and byte-compare with public outputs. No writes."""
    with tempfile.TemporaryDirectory(prefix="3d-tiles-check-") as tmp:
        derived = Path(tmp) / "3d-tiles"
        manifest = build_tileset(derived)
        failures = []
        expected_rels = (
            ["tileset.json", "manifest.json", OVERVIEW_URI]
            + [f"tiles/{tid}.glb" for tid in TILE_IDS]
        )
        for rel in expected_rels:
            expected = (derived / rel).read_bytes()
            public = DEFAULT_OUT / rel
            if not public.exists():
                failures.append(f"missing public file {rel}")
                continue
            if public.read_bytes() != expected:
                failures.append(f"hash drift in {rel}")
        for legacy in (DEFAULT_OUT / "tiles").glob("*.gltf"):
            failures.append(f"stale legacy payload {legacy.name}")
        # Manifest digest pins the derivation; compare ignoring no fields (all deterministic).
        public_manifest = json.loads((DEFAULT_OUT / "manifest.json").read_text(encoding="utf-8"))
        if public_manifest.get("manifestSha256") != manifest.get("manifestSha256"):
            failures.append("manifest digest drift")
        if failures:
            for failure in failures:
                print(f"[check:fail] {failure}", file=sys.stderr)
            return 1
        print(f"[check:ok] 36 leaves + overview + tileset + manifest deterministic ({manifest['manifestSha256'][:16]}…)")
        return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out-dir", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--check", action="store_true", help="rebuild to temp and compare, without writing")
    args = parser.parse_args(argv)
    if args.check:
        return check_against_public()
    manifest = build_tileset(args.out_dir)
    print(f"[ok] 36 leaves + overview -> {args.out_dir}")
    print(f"[ok] lod_error={manifest['geometricError']['root']:.3f} m datum={VERTICAL_DATUM:.0f} manifest={manifest['manifestSha256'][:16]}…")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
