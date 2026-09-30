#!/usr/bin/env python3
"""Build an isolated 3D Tiles proof of concept from the game's local map data."""

from __future__ import annotations

import json
import math
import struct
from pathlib import Path

from PIL import Image


ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'public' / 'tiles-poc'
X_MIN, X_MAX = 2000, 5000
Y_MIN, Y_MAX = 2000, 5000
SAMPLE_STEP = 10
DATUM = 870.0


def align4(buffer: bytearray) -> None:
    while len(buffer) % 4:
        buffer.append(0)


def add_accessor(gltf: dict, binary: bytearray, values: list[float] | list[int], component_type: int,
                 accessor_type: str, count: int, bounds: bool = False) -> int:
    align4(binary)
    offset = len(binary)
    fmt = 'f' if component_type == 5126 else 'I'
    binary.extend(struct.pack('<' + fmt * len(values), *values))
    view_index = len(gltf['bufferViews'])
    gltf['bufferViews'].append({'buffer': 0, 'byteOffset': offset, 'byteLength': len(binary) - offset,
                                'target': 34962 if component_type == 5126 else 34963})
    accessor = {'bufferView': view_index, 'componentType': component_type, 'count': count, 'type': accessor_type}
    if bounds and values:
        dims = {'VEC3': 3, 'VEC2': 2, 'SCALAR': 1}[accessor_type]
        components = [values[i::dims] for i in range(dims)]
        accessor['min'] = [min(axis) for axis in components]
        accessor['max'] = [max(axis) for axis in components]
    index = len(gltf['accessors'])
    gltf['accessors'].append(accessor)
    return index


def sample_height(grid: dict, x: float, y: float) -> float:
    gx = max(0.0, min((x - grid['grid']['x0']) / grid['grid']['dx'], grid['grid']['columns'] - 1))
    gy = max(0.0, min((y - grid['grid']['z0']) / grid['grid']['dz'], grid['grid']['rows'] - 1))
    x0, y0 = int(gx), int(gy)
    x1, y1 = min(x0 + 1, grid['grid']['columns'] - 1), min(y0 + 1, grid['grid']['rows'] - 1)
    fx, fy = gx - x0, gy - y0
    h = grid['grid']['heights']
    cols = grid['grid']['columns']
    a = h[y0 * cols + x0] * (1 - fx) + h[y0 * cols + x1] * fx
    b = h[y1 * cols + x0] * (1 - fx) + h[y1 * cols + x1] * fx
    return a * (1 - fy) + b * fy - DATUM


def main() -> None:
    terrain_tiles = {}
    for tile_x in range(X_MIN // 1000, X_MAX // 1000):
        for tile_y in range(Y_MIN // 1000, Y_MAX // 1000):
            path = ROOT / 'public' / 'terrain' / 'tiles' / f'tile_{tile_x}_{tile_y}.json'
            terrain_tiles[(tile_x, tile_y)] = json.loads(path.read_text())

    def get_height(x: int, y: int) -> float:
        tx = min(x // 1000, X_MAX // 1000 - 1)
        ty = min(y // 1000, Y_MAX // 1000 - 1)
        tile = terrain_tiles[(tx, ty)]['grid']
        col = round((x - tile['x0']) / tile['dx'])
        row = round((y - tile['z0']) / tile['dz'])
        return float(tile['heights'][row * tile['columns'] + col])

    x_values = list(range(X_MIN, X_MAX + 1, SAMPLE_STEP))
    y_values = list(range(Y_MIN, Y_MAX + 1, SAMPLE_STEP))
    cols, rows = len(x_values), len(y_values)
    heights = [get_height(x, y) for y in y_values for x in x_values]
    height_grid = {'grid': {'x0': X_MIN, 'z0': Y_MIN, 'dx': SAMPLE_STEP, 'dz': SAMPLE_STEP,
                            'columns': cols, 'rows': rows, 'heights': heights}}

    OUT.mkdir(parents=True, exist_ok=True)
    source_image = Image.open(ROOT / 'public' / 'terrain' / 'orthophoto.webp').convert('RGB')
    # The source atlas is north-up; crop the 1 km tile with a modest 512 px texture.
    atlas_scale = source_image.width / 6000
    crop_left = round(X_MIN * atlas_scale)
    crop_top = round((6000 - Y_MAX) * atlas_scale)
    crop_size = round((X_MAX - X_MIN) * atlas_scale)
    source_image.crop((crop_left, crop_top, crop_left + crop_size, crop_top + crop_size)) \
        .resize((1536, 1536), Image.Resampling.LANCZOS).save(OUT / 'orthophoto.jpg', quality=86, optimize=True)

    vertices: list[float] = []
    normals: list[float] = []
    uvs: list[float] = []
    for row in range(rows):
        for col in range(cols):
            idx = row * cols + col
            x, y = x_values[col], y_values[row]
            vertices.extend([x, y, heights[idx] - DATUM])
            left = heights[row * cols + max(0, col - 1)]
            right = heights[row * cols + min(cols - 1, col + 1)]
            south = heights[max(0, row - 1) * cols + col]
            north = heights[min(rows - 1, row + 1) * cols + col]
            nx = -(right - left) / max(SAMPLE_STEP * (2 if col not in (0, cols - 1) else 1), 1)
            ny = -(north - south) / max(SAMPLE_STEP * (2 if row not in (0, rows - 1) else 1), 1)
            length = math.sqrt(nx * nx + ny * ny + 1)
            normals.extend([nx / length, ny / length, 1 / length])
            uvs.extend([col / (cols - 1), row / (rows - 1)])

    terrain_indices: list[int] = []
    for row in range(rows - 1):
        for col in range(cols - 1):
            sw = row * cols + col
            se, nw, ne = sw + 1, sw + cols, sw + cols + 1
            terrain_indices.extend([sw, se, ne, sw, ne, nw])

    # Extrude the OpenStreetMap building outlines in this one-kilometre tile.
    village = json.loads((ROOT / 'public' / 'village' / 'buildings.json').read_text())
    b_positions: list[float] = []
    b_normals: list[float] = []
    b_indices: list[int] = []
    for building in village['buildings']:
        points = [(float(p[0]), float(p[1])) for p in building['footprint']]
        if len(points) < 3 or not all(X_MIN <= x <= X_MAX and Y_MIN <= y <= Y_MAX for x, y in points):
            continue
        base = len(b_positions) // 3
        roof_height = float(building.get('heightM') or 6.0)
        bottoms = [sample_height(height_grid, x, y) for x, y in points]
        base_height = sum(bottoms) / len(bottoms)
        count = len(points)
        # Flat roof cap, retaining the mapped footprint outline.
        for x, y in points:
            b_positions.extend([x, y, base_height + roof_height])
            b_normals.extend([0.0, 0.0, 1.0])
        for i in range(1, count - 1):
            b_indices.extend([base, base + i, base + i + 1])
        # Four vertices per wall keep simple face normals and avoid smoothing corners.
        for i, (x1, y1) in enumerate(points):
            j = (i + 1) % count
            x2, y2 = points[j]
            dx, dy = x2 - x1, y2 - y1
            wall_len = math.hypot(dx, dy) or 1
            nx, ny = dy / wall_len, -dx / wall_len
            wall_base = len(b_positions) // 3
            z1, z2 = bottoms[i], bottoms[j]
            b_positions.extend([x1, y1, z1, x2, y2, z2, x2, y2, base_height + roof_height, x1, y1, base_height + roof_height])
            b_normals.extend([nx, ny, 0.0] * 4)
            b_indices.extend([wall_base, wall_base + 1, wall_base + 2, wall_base, wall_base + 2, wall_base + 3])

    gltf = {
        'asset': {'version': '2.0', 'generator': 'Montes de Oca 3D Tiles proof of concept'},
        'scene': 0, 'scenes': [{'nodes': [0, 1]}],
        'nodes': [{'mesh': 0, 'name': 'IGN MDT05 terrain'}, {'mesh': 1, 'name': 'OSM building outlines'}],
        'meshes': [{'primitives': [{'attributes': {}, 'indices': 0, 'material': 0}]},
                   {'primitives': [{'attributes': {}, 'indices': 0, 'material': 1}]}],
        'materials': [
            {'name': 'PNOA 2023 orthophoto', 'pbrMetallicRoughness': {'baseColorTexture': {'index': 0}, 'metallicFactor': 0, 'roughnessFactor': 1}},
            {'name': 'OSM buildings', 'pbrMetallicRoughness': {'baseColorFactor': [0.68, 0.57, 0.44, 1], 'metallicFactor': 0, 'roughnessFactor': 1}},
        ],
        'textures': [{'sampler': 0, 'source': 0}],
        'images': [{'uri': 'orthophoto.jpg'}],
        'samplers': [{'magFilter': 9729, 'minFilter': 9987, 'wrapS': 33071, 'wrapT': 33071}],
        'buffers': [{'uri': 'tile.bin', 'byteLength': 0}],
        'bufferViews': [], 'accessors': [],
    }
    binary = bytearray()
    pos = add_accessor(gltf, binary, vertices, 5126, 'VEC3', len(vertices) // 3, True)
    normal = add_accessor(gltf, binary, normals, 5126, 'VEC3', len(normals) // 3)
    uv = add_accessor(gltf, binary, uvs, 5126, 'VEC2', len(uvs) // 2)
    t_idx = add_accessor(gltf, binary, terrain_indices, 5125, 'SCALAR', len(terrain_indices))
    b_pos = add_accessor(gltf, binary, b_positions, 5126, 'VEC3', len(b_positions) // 3, True)
    b_normal = add_accessor(gltf, binary, b_normals, 5126, 'VEC3', len(b_normals) // 3)
    b_idx = add_accessor(gltf, binary, b_indices, 5125, 'SCALAR', len(b_indices))
    gltf['buffers'][0]['byteLength'] = len(binary)
    gltf['meshes'][0]['primitives'][0]['attributes'] = {'POSITION': pos, 'NORMAL': normal, 'TEXCOORD_0': uv}
    gltf['meshes'][0]['primitives'][0]['indices'] = t_idx
    gltf['meshes'][1]['primitives'][0]['attributes'] = {'POSITION': b_pos, 'NORMAL': b_normal}
    gltf['meshes'][1]['primitives'][0]['indices'] = b_idx
    (OUT / 'tile.bin').write_bytes(binary)
    (OUT / 'tile.gltf').write_text(json.dumps(gltf, separators=(',', ':')))

    h_min, h_max = min(heights) - DATUM, max(heights) - DATUM + 20
    tileset = {
        'asset': {'version': '1.0', 'gltfUpAxis': 'Z'},
        'geometricError': 0,
        'root': {
            'boundingVolume': {'box': [(X_MIN + X_MAX) / 2, (Y_MIN + Y_MAX) / 2, (h_min + h_max) / 2,
                                      (X_MAX - X_MIN) / 2, 0, 0, 0, (Y_MAX - Y_MIN) / 2, 0,
                                      0, 0, (h_max - h_min) / 2]},
            'geometricError': 0,
            'refine': 'REPLACE',
            'content': {'uri': 'tile.gltf'},
        },
    }
    (OUT / 'tileset.json').write_text(json.dumps(tileset, indent=2))
    print(f'Built {OUT}: {len(vertices) // 3:,} terrain vertices, {len(b_positions) // 3:,} building vertices, {len(binary):,} bytes binary')


if __name__ == '__main__':
    main()
