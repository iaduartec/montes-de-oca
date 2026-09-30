#!/usr/bin/env python3
"""Build one exact gameplay terrain tile as isolated 3D Tiles glTF content."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import shutil
import re
import struct
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
DEFAULT_OUT = ROOT / 'public' / 'tiles-benchmark' / 'equivalent'


def add_view(binary: bytearray, payload: bytes, target: int) -> dict:
    while len(binary) % 4:
        binary.append(0)
    offset = len(binary)
    binary.extend(payload)
    return {'buffer': 0, 'byteOffset': offset, 'byteLength': len(payload), 'target': target}


def surface_height(grid: dict, x: float, z: float) -> float:
    col = (x - grid['x0']) / grid['dx']
    row = (z - grid['z0']) / grid['dz']
    col = max(0.0, min(col, grid['columns'] - 1))
    row = max(0.0, min(row, grid['rows'] - 1))
    i = min(math.floor(col), grid['columns'] - 2)
    j = min(math.floor(row), grid['rows'] - 2)
    u, v = col - i, row - j
    k = j * grid['columns'] + i
    heights = grid['heights']
    sw, se = heights[k], heights[k + 1]
    nw, ne = heights[k + grid['columns']], heights[k + grid['columns'] + 1]
    return (sw * (1 - u) + se * (u - v) + ne * v) if u >= v else (sw * (1 - v) + ne * u + nw * (v - u))


def normal_at(grid: dict, x: float, z: float, world_scale: float) -> tuple[float, float, float]:
    step = min(grid['dx'], grid['dz'])
    x0, z0 = grid['x0'], grid['z0']
    x1 = x0 + (grid['columns'] - 1) * grid['dx']
    z1 = z0 + (grid['rows'] - 1) * grid['dz']
    left, right = max(x0, x - step), min(x1, x + step)
    back, front = max(z0, z - step), min(z1, z + step)
    dhx = (surface_height(grid, right, z) - surface_height(grid, left, z)) * world_scale / (right - left)
    dhz = (surface_height(grid, x, front) - surface_height(grid, x, back)) * world_scale / (front - back)
    nx, ny, nz = -dhx, 1.0, -dhz
    length = math.sqrt(nx * nx + ny * ny + nz * nz)
    return nx / length, ny / length, nz / length


def accessor(gltf: dict, binary: bytearray, values: list[float] | list[int], fmt: str,
             component_type: int, kind: str, target: int, bounds: bool = False) -> int:
    payload = struct.pack('<' + fmt * len(values), *values)
    view = add_view(binary, payload, target)
    dims = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4}[kind]
    count = len(values) // dims
    item = {'bufferView': len(gltf['bufferViews']), 'componentType': component_type, 'count': count, 'type': kind}
    if bounds:
        components = [values[i::dims] for i in range(dims)]
        item['min'] = [min(axis) for axis in components]
        item['max'] = [max(axis) for axis in components]
    gltf['bufferViews'].append(view)
    gltf['accessors'].append(item)
    return len(gltf['accessors']) - 1


def build(tile_id: str, out: Path) -> dict:
    if not re.fullmatch(r'tile_\d+_\d+', tile_id):
        raise ValueError(f'unsupported tile id: {tile_id}')
    config = json.loads((ROOT / 'public/terrain/config.json').read_text())
    manifest = json.loads((ROOT / 'public/terrain/orthophoto.json').read_text())
    source_path = ROOT / 'public' / 'terrain' / 'tiles' / f'{tile_id}.json'
    tile = json.loads(source_path.read_text())
    grid = tile['grid']
    columns, rows = grid['columns'], grid['rows']
    if columns != 201 or rows != 201 or len(grid['heights']) != columns * rows:
        raise ValueError(f'{tile_id}: expected a native 201x201 gameplay tile, received {columns}x{rows}')

    scale = config['worldScale']
    datum = config['verticalDatum']
    bounds_width = config['bounds']['e'][1] - config['bounds']['e'][0]
    bounds_depth = config['bounds']['n'][1] - config['bounds']['n'][0]
    positions: list[float] = []
    normals: list[float] = []
    colors: list[float] = []
    uvs: list[float] = []
    for row in range(rows):
        z = grid['z0'] + row * grid['dz']
        for col in range(columns):
            x = grid['x0'] + col * grid['dx']
            height = float(grid['heights'][row * columns + col])
            positions.extend([x, (height - datum) * scale, z])
            normals.extend(normal_at(grid, x, z, scale))
            macro = 1 + 0.07 * math.sin(x * 0.022 + z * 0.031) * math.cos(z * 0.028 - x * 0.017)
            colors.extend([macro, macro, macro, 1.0])
            # GLTF's texture-coordinate origin is opposite Babylon Texture's
            # direct terrain upload; invert V to keep the PNOA north/south
            # orientation identical to `terrainTileOrthophotoUV`.
            uvs.extend([x / bounds_width, 1 - z / bounds_depth])

    indices: list[int] = []
    for row in range(rows - 1):
        for col in range(columns - 1):
            sw = row * columns + col
            se, nw, ne = sw + 1, sw + columns, sw + columns + 1
            indices.extend([sw, ne, se, sw, nw, ne])

    gltf = {
        'asset': {'version': '2.0', 'generator': 'Montes de Oca exact gameplay terrain tile benchmark'},
        'scene': 0,
        'scenes': [{'nodes': [0]}],
        'nodes': [{'mesh': 0, 'name': f'IGN MDT05 terrain {tile_id}'}],
        'meshes': [{'primitives': [{'attributes': {}, 'indices': 0, 'material': 0}]}],
        'materials': [{'name': 'PNOA 2023 orthophoto', 'pbrMetallicRoughness': {
            'baseColorTexture': {'index': 0}, 'metallicFactor': 0, 'roughnessFactor': 0.96}}],
        'textures': [{'sampler': 0, 'source': 0}],
        # glTF validation forbids parent traversal. Copy the atlas bytes as-is
        # beside the content and verify identity with the live terrain asset.
        'images': [{'uri': 'orthophoto.webp'}],
        'samplers': [{'magFilter': 9729, 'minFilter': 9987, 'wrapS': 33071, 'wrapT': 33071}],
        'buffers': [{'uri': 'tile.bin', 'byteLength': 0}],
        'bufferViews': [], 'accessors': [],
    }
    binary = bytearray()
    pos = accessor(gltf, binary, positions, 'f', 5126, 'VEC3', 34962, True)
    norm = accessor(gltf, binary, normals, 'f', 5126, 'VEC3', 34962)
    color = accessor(gltf, binary, colors, 'f', 5126, 'VEC4', 34962)
    uv = accessor(gltf, binary, uvs, 'f', 5126, 'VEC2', 34962)
    index = accessor(gltf, binary, indices, 'H', 5123, 'SCALAR', 34963)
    gltf['buffers'][0]['byteLength'] = len(binary)
    gltf['meshes'][0]['primitives'][0]['attributes'] = {
        'POSITION': pos, 'NORMAL': norm, 'COLOR_0': color, 'TEXCOORD_0': uv}
    gltf['meshes'][0]['primitives'][0]['indices'] = index

    out.mkdir(parents=True, exist_ok=True)
    atlas_source = ROOT / 'public' / manifest['asset']['url'].lstrip('/')
    atlas_copy = out / 'orthophoto.webp'
    shutil.copyfile(atlas_source, atlas_copy)
    if hashlib.sha256(atlas_copy.read_bytes()).hexdigest() != manifest['asset']['sha256']:
        raise ValueError('copied orthophoto atlas does not match the terrain manifest SHA-256')
    (out / 'tile.bin').write_bytes(binary)
    (out / 'tile.gltf').write_text(json.dumps(gltf, separators=(',', ':')))
    heights_world = [(float(h) - datum) * scale for h in grid['heights']]
    min_y, max_y = min(heights_world), max(heights_world)
    x_min, z_min = grid['x0'], grid['z0']
    x_max = x_min + (columns - 1) * grid['dx']
    z_max = z_min + (rows - 1) * grid['dz']
    pad = 0.05
    tileset = {
        'asset': {'version': '1.0', 'gltfUpAxis': 'Y'},
        'geometricError': 0,
        'root': {
            'boundingVolume': {'box': [
                (x_min + x_max) / 2, -(z_min + z_max) / 2, (min_y + max_y) / 2,
                (x_max - x_min) / 2, 0, 0, 0, (z_max - z_min) / 2, 0,
                0, 0, (max_y - min_y) / 2 + pad]},
            'geometricError': 0,
            'refine': 'REPLACE',
            'content': {'uri': 'tile.gltf'},
        },
    }
    (out / 'tileset.json').write_text(json.dumps(tileset, separators=(',', ':')))
    (out / 'ATTRIBUTION.md').write_text(
        f'# Equivalent 3D Tiles benchmark asset\n\n'
        f'- Tile `{tile_id}`: exact 201×201 MDT05 height samples from `{source_path.relative_to(ROOT)}`; '
        f'© IGN/CNIG, CC BY 4.0.\n'
        f'- Orthophoto: byte-identical copy of `{manifest["asset"]["url"]}` PNOA atlas; '
        f'© IGN/CNIG, CC BY 4.0; source details in `public/terrain/ATTRIBUTION.md`.\n'
        f'- UV coordinates address the same 6144×6144 atlas as the gameplay terrain mesh.\n'
        f'- Mesh settings: `{columns}×{rows}` vertices, {len(indices) // 3} triangles, '
        f'worldScale {scale}, vertical datum {datum} m.\n'
    )
    return {
        'tileId': tile_id, 'columns': columns, 'rows': rows, 'vertices': columns * rows,
        'triangles': len(indices) // 3, 'datum': datum, 'worldScale': scale,
        'atlas': manifest['asset'], 'encodedGeometryBytes': len(binary),
        'estimatedGpuGeometryBytes': columns * rows * (3 + 3 + 4 + 2) * 4 + len(indices) * 2,
        'bounds': {'x': [x_min, x_max], 'z': [z_min, z_max], 'y': [min_y, max_y]},
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('--tile-id', default='tile_3_3')
    parser.add_argument('--out-dir', type=Path, default=DEFAULT_OUT)
    args = parser.parse_args()
    out = args.out_dir if args.out_dir.is_absolute() else ROOT / args.out_dir
    print(json.dumps(build(args.tile_id, out), indent=2))


if __name__ == '__main__':
    main()
