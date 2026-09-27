#!/usr/bin/env python3
"""Build the eight-house Villafranca pilot in Blender and export one batched GLB.

Run with:
  blender --background --factory-startup --python scripts/environment/build_village_pilot.py

Only versioned OSM footprints, the IGN height grid, and the versioned terrain
tiles are inputs. Facade openings, tile courses, stone returns and chimneys are
artistic low-poly additions; they are not surveyed building details.
"""

import json
import math
import os
import struct
import hashlib
from pathlib import Path

import bpy
from mathutils import Vector


ROOT = Path(__file__).resolve().parents[2]
BUILDINGS_FILE = ROOT / 'public/village/buildings.json'
RAW_OSM_FILE = ROOT / 'data/gameplay/raw/osm_buildings_villafranca.json'
HEIGHT_GRID_FILE = ROOT / 'public/village/building_height_grid.json'
TERRAIN_CONFIG_FILE = ROOT / 'public/terrain/config.json'
BLEND_FILE = ROOT / 'assets/environment/village-pilot/village-pilot.blend'
GLB_FILE = ROOT / 'public/village/pilot-houses.glb'
MANIFEST_FILE = ROOT / 'public/village/pilot-houses.json'

PILOT_IDS = (
    474364247,
    474364248,
    818885678,
    1509797545,
    1509797544,
    305647007,
    310458426,
    433198559,
)
SPAWN = (3087.53, 3935.05)
FALDON_M = 1.5
MIN_LIDAR_SAMPLES = 4
GABLE_ELONGATION = 1.35
# Roof-shape override justified by the dated, georeferenced PNOA 2023
# orthophoto (see assets/environment/real-structures/evidence.json). These two
# near-square Calle Mayor row houses carry a long two-slope gable roof in the
# image; the isotropic elongation heuristic would otherwise pick the compact
# hip/pyramid that visibly disagrees with the photograph.
PNOA_GABLE_IDS = frozenset({474364247, 474364248})
BODY_COLOR = {
    'piedra': (0.50, 0.46, 0.40),
    'revoco': (0.82, 0.76, 0.66),
    'teja': (0.74, 0.60, 0.46),
    'ladrillo': (0.62, 0.38, 0.30),
}
ROOF_COLOR = {'teja': (0.60, 0.32, 0.24), 'chapa': (0.56, 0.58, 0.59), 'pizarra': (0.32, 0.32, 0.36)}
STONE = (0.66, 0.60, 0.50)
WOOD = (0.34, 0.25, 0.17)
GLASS = (0.12, 0.13, 0.13)
TRIM = (0.88, 0.82, 0.70)
CHIMNEY_IDS = {474364247, 474364248, 305647007, 310458426}
STONE_RETURN_IDS = {474364247, 1509797545, 305647007}


def read_json(path):
    with path.open(encoding='utf8') as stream:
        return json.load(stream)


def signed_area(points):
    return sum(
        points[i][0] * points[(i + 1) % len(points)][1]
        - points[(i + 1) % len(points)][0] * points[i][1]
        for i in range(len(points))
    ) / 2


def principal_axis(points):
    area = signed_area(points)
    if abs(area) > 1e-9:
        cx = sum(
            (points[i][0] + points[(i + 1) % len(points)][0])
            * (points[i][0] * points[(i + 1) % len(points)][1] - points[(i + 1) % len(points)][0] * points[i][1])
            for i in range(len(points))
        ) / (6 * area)
        cz = sum(
            (points[i][1] + points[(i + 1) % len(points)][1])
            * (points[i][0] * points[(i + 1) % len(points)][1] - points[(i + 1) % len(points)][0] * points[i][1])
            for i in range(len(points))
        ) / (6 * area)
    else:
        cx = sum(p[0] for p in points) / len(points)
        cz = sum(p[1] for p in points) / len(points)
    sxx = szz = sxz = 0.0
    for x, z in points:
        dx, dz = x - cx, z - cz
        sxx += dx * dx
        szz += dz * dz
        sxz += dx * dz
    theta = 0.5 * math.atan2(2 * sxz, sxx - szz)
    ux, uz = math.cos(theta), math.sin(theta)
    half_u = max(abs((x - cx) * ux + (z - cz) * uz) for x, z in points)
    half_v = max(abs((x - cx) * -uz + (z - cz) * ux) for x, z in points)
    return (cx, cz), (ux, uz), half_u, half_v


def roof_is_gable(building_id, half_u, half_v):
    """Two-slope gable decision: PNOA-observed override or elongated footprint."""
    return building_id in PNOA_GABLE_IDS or (half_v > 0.5 and half_u / half_v >= GABLE_ELONGATION)


def inside_polygon(points, x, z):
    inside = False
    j = len(points) - 1
    for i, (xi, zi) in enumerate(points):
        xj, zj = points[j]
        if (zi > z) != (zj > z) and x < (xj - xi) * (z - zi) / (zj - zi) + xi:
            inside = not inside
        j = i
    return inside


def lidar_wall_height(building, grid, values, terrain_config):
    if building.get('heightSource') == 'height':
        return None, 0, None
    e0, n0 = terrain_config['bounds']['e'][0], terrain_config['bounds']['n'][0]
    world_scale = terrain_config.get('worldScale', 1)
    points = building['footprint']
    min_e = e0 + min(p[0] for p in points) / world_scale
    max_e = e0 + max(p[0] for p in points) / world_scale
    min_n = n0 + min(p[1] for p in points) / world_scale
    max_n = n0 + max(p[1] for p in points) / world_scale
    col_min = max(0, math.floor((min_e - grid['top_left_easting_m']) / grid['pixel_size_m']))
    col_max = min(grid['width'] - 1, math.floor((max_e - grid['top_left_easting_m']) / grid['pixel_size_m']))
    row_min = max(0, math.floor((grid['top_left_northing_m'] - max_n) / grid['pixel_size_m']))
    row_max = min(grid['height'] - 1, math.floor((grid['top_left_northing_m'] - min_n) / grid['pixel_size_m']))
    samples = []
    for row in range(row_min, row_max + 1):
        z = (grid['top_left_northing_m'] - (row + 0.5) * grid['pixel_size_m'] - n0) * world_scale
        for col in range(col_min, col_max + 1):
            value = values[row * grid['width'] + col]
            if value <= 0:
                continue
            x = (grid['top_left_easting_m'] + (col + 0.5) * grid['pixel_size_m'] - e0) * world_scale
            if inside_polygon(points, x, z):
                samples.append(value)
    samples.sort()
    if len(samples) < MIN_LIDAR_SAMPLES:
        return None, len(samples), None
    roof_height = samples[math.floor((len(samples) - 1) * 0.95)]
    _, _, half_u, half_v = principal_axis(points)
    gable = roof_is_gable(building['id'], half_u, half_v)
    roof_rise = min(max(0.5 * half_v, 0.4), 3) if gable else 0
    wall_height = roof_height - roof_rise
    if wall_height < 2 or wall_height > 60:
        return None, len(samples), roof_height
    return wall_height, len(samples), roof_height


def load_terrain_samplers(config):
    samplers = []
    for tile_ref in config['tiles']:
        tile = read_json(ROOT / 'public' / tile_ref['url'].lstrip('/'))
        samplers.append(tile['grid'])
    return samplers


def terrain_height_at(samplers, config, x, z):
    scale = config.get('worldScale', 1)
    datum = config['verticalDatum'] * scale
    selected = None
    for grid in samplers:
        max_x = grid['x0'] + (grid['columns'] - 1) * grid['dx']
        max_z = grid['z0'] + (grid['rows'] - 1) * grid['dz']
        if grid['x0'] <= x <= max_x and grid['z0'] <= z <= max_z:
            selected = grid
            break
    if selected is None:
        return 0
    grid = selected
    c = (x - grid['x0']) / grid['dx']
    r = (z - grid['z0']) / grid['dz']
    i = min(math.floor(c), grid['columns'] - 2)
    j = min(math.floor(r), grid['rows'] - 2)
    u, v = c - i, r - j
    k = j * grid['columns'] + i
    h = grid['heights']
    h_sw = h[k]
    h_se = h[k + 1]
    h_nw = h[k + grid['columns']]
    h_ne = h[k + grid['columns'] + 1]
    absolute = (
        h_sw * (1 - u) + h_se * (u - v) + h_ne * v
        if u >= v else h_sw * (1 - v) + h_ne * u + h_nw * (v - u)
    )
    return absolute * scale - datum


def tint(body, seed):
    h = (seed ^ 0x9E3779B9) & 0xFFFFFFFF
    h = ((h ^ (h >> 16)) * 0x85EBCA6B) & 0xFFFFFFFF
    h = ((h ^ (h >> 13)) * 0xC2B2AE35) & 0xFFFFFFFF
    h = (h ^ (h >> 16)) & 0xFFFFFFFF
    brightness = 0.95 + ((h & 0xFFFF) / 0xFFFF) * 0.1
    warm = 0.985 + (((h >> 16) & 0xFF) / 0xFF) * 0.03
    cool = 0.985 + (((h >> 24) & 0xFF) / 0xFF) * 0.03
    return (body[0] * brightness * warm, body[1] * brightness, body[2] * brightness * cool)


def roof_tint(color, seed):
    h = (seed ^ 0x85EBCA6B) & 0xFFFFFFFF
    h = ((h ^ (h >> 16)) * 0xC2B2AE35) & 0xFFFFFFFF
    h = ((h ^ (h >> 13)) * 0x27D4EB2F) & 0xFFFFFFFF
    h = (h ^ (h >> 16)) & 0xFFFFFFFF
    brightness = 0.88 + ((h & 0xFFFF) / 0xFFFF) * 0.24
    red = 0.98 + (((h >> 16) & 0xFF) / 0xFF) * 0.05
    blue = 0.93 + (((h >> 24) & 0xFF) / 0xFF) * 0.05
    return (color[0] * brightness * red, color[1] * brightness, color[2] * brightness * blue)


def blender_point(x, z, y):
    # Blender source uses X=east, Y=north, Z=up. glTF Y-up export + Babylon's
    # standard handedness conversion restores the game's positive world Z.
    return (x, z, y)


class Faces:
    def __init__(self):
        self.vertices = []
        self.faces = []
        self.colors = []

    def face(self, points, color):
        start = len(self.vertices)
        self.vertices.extend(blender_point(x, z, y) for x, y, z in points)
        self.faces.append(tuple(range(start, start + len(points))))
        self.colors.extend((*color, 1.0) for _ in points)

    def triangle(self, a, b, c, color):
        self.face((a, b, c), color)

    def quad(self, a, b, c, d, color):
        self.face((a, b, c, d), color)


def facade_quad(faces, facade, s0, s1, y0, y1, color, out=0.08):
    ax, az, bx, bz, nx, nz, length = facade
    ex, ez = (bx - ax) / length, (bz - az) / length
    point = lambda s, y: (ax + ex * s + nx * out, y, az + ez * s + nz * out)
    faces.quad(point(s0, y0), point(s1, y0), point(s1, y1), point(s0, y1), color)


def build_roof(points, faces, axis, top_y, rise, roof_color, gable):
    (cx, cz), (ux, uz), half_u, half_v = axis
    proj = []
    for x, z in points:
        dx, dz = x - cx, z - cz
        proj.append((dx * ux + dz * uz, dx * -uz + dz * ux))

    roof_y = [top_y + rise * (1 - min(1, abs(v) / half_v)) if gable else top_y for _, v in proj]
    ridge_span = max(1e-6, 2 * half_u)
    if gable:
        for i, a in enumerate(points):
            j = (i + 1) % len(points)
            b = points[j]
            ua, ub = proj[i][0], proj[j][0]
            end_edge = abs(ua - ub) <= 0.05 * ridge_span
            ridge_a = (cx + ux * ua, top_y + rise, cz + uz * ua)
            ridge_b = (cx + ux * ub, top_y + rise, cz + uz * ub)
            pa = (a[0], roof_y[i], a[1])
            pb = (b[0], roof_y[j], b[1])
            if end_edge:
                faces.triangle(pa, pb, (cx + ux * ((ua + ub) / 2), top_y + rise, cz + uz * ((ua + ub) / 2)), roof_color)
            else:
                faces.triangle(pa, pb, ridge_b, roof_color)
                faces.triangle(pa, ridge_b, ridge_a, roof_color)
        # Fine, subtle tile ribs running from the ridge to the eaves.
        count = min(24, max(4, math.ceil((2 * half_u) / 0.85)))
        for side in (-1, 1):
            for index in range(count):
                u = -half_u * 0.88 + (2 * half_u * 0.88) * index / max(1, count - 1)
                du = 0.07
                for edge_u, other_u in ((u - du / 2, u + du / 2),):
                    # Convex-section assumption is limited to the selected roof
                    # footprints; roof itself still follows every OSM edge.
                    section = []
                    for q in (edge_u, other_u):
                        hits = []
                        for k, (u0, v0) in enumerate(proj):
                            u1, v1 = proj[(k + 1) % len(proj)]
                            if (u0 <= q <= u1) or (u1 <= q <= u0):
                                if abs(u1 - u0) < 1e-8:
                                    hits.extend((v0, v1))
                                else:
                                    hits.append(v0 + (v1 - v0) * ((q - u0) / (u1 - u0)))
                        if not hits:
                            section = []
                            break
                        section.append(max(hits) if side > 0 else min(hits))
                    if len(section) != 2:
                        continue
                    v0, v1 = section[0] - side * 0.08, section[1] - side * 0.08
                    if abs(v0) < 0.12 or abs(v1) < 0.12:
                        continue
                    def p(q, v):
                        return (cx + ux * q - uz * v, top_y + rise * (1 - min(1, abs(v) / half_v)) + 0.018, cz + uz * q + ux * v)
                    rib = (roof_color[0] * 0.78, roof_color[1] * 0.75, roof_color[2] * 0.73)
                    faces.triangle(p(edge_u, side * 0.08), p(other_u, side * 0.08), p(other_u, v1), rib)
                    faces.triangle(p(edge_u, side * 0.08), p(other_u, v1), p(edge_u, v0), rib)
        return roof_y

    # Low-poly hipped roof. The selected polygons are convex; each slope joins
    # one footprint edge to the compact ridge point.
    if half_u > 0.5 and half_v > 0.5:
        for i, a in enumerate(points):
            b = points[(i + 1) % len(points)]
            faces.triangle((a[0], top_y, a[1]), (b[0], top_y, b[1]), (cx, top_y + min(1.4, half_v * 0.5), cz), roof_color)
    else:
        for i in range(1, len(points) - 1):
            faces.triangle((points[0][0], top_y, points[0][1]), (points[i][0], top_y, points[i][1]), (points[i + 1][0], top_y, points[i + 1][1]), roof_color)
    return [top_y] * len(points)


def build_building(building, tags, terrain_samplers, terrain_config, lidar_grid, lidar_values):
    faces = Faces()
    points = [tuple(point) for point in building['footprint']]
    area = abs(signed_area(points))
    axis = principal_axis(points)
    _, _, half_u, half_v = axis
    elongated = roof_is_gable(building['id'], half_u, half_v)
    height, lidar_samples, lidar_roof = lidar_wall_height(building, lidar_grid, lidar_values, terrain_config)
    if height is None:
        height = building['heightM']
    min_y = min(terrain_height_at(terrain_samplers, terrain_config, x, z) for x, z in points)
    base_y = min_y - FALDON_M
    top_y = min_y + height
    rise = min(max(0.5 * half_v, 0.4), 3) if elongated else 0
    gable = elongated
    body = tint(BODY_COLOR.get(building['materialKind'], BODY_COLOR['revoco']), building['id'])
    roof = roof_tint(ROOF_COLOR.get(building['roofKind'], ROOF_COLOR['teja']), building['id'])

    for i, a in enumerate(points):
        j = (i + 1) % len(points)
        b = points[j]
        # Store footings down the terrain slope exactly as village.ts does.
        if signed_area(points) > 0:
            normal = (b[1] - a[1], a[0] - b[0])
        else:
            normal = (a[1] - b[1], b[0] - a[0])
        norm = math.hypot(*normal) or 1
        nx, nz = normal[0] / norm, normal[1] / norm
        top_a = top_y + rise * (1 - min(1, abs((a[0] - axis[0][0]) * -axis[1][1] + (a[1] - axis[0][1]) * axis[1][0]) / half_v)) if gable else top_y
        top_b = top_y + rise * (1 - min(1, abs((b[0] - axis[0][0]) * -axis[1][1] + (b[1] - axis[0][1]) * axis[1][0]) / half_v)) if gable else top_y
        faces.quad((a[0], base_y, a[1]), (b[0], base_y, b[1]), (b[0], top_b, b[1]), (a[0], top_a, a[1]), body)
        facade = (a[0], a[1], b[0], b[1], nx, nz, math.hypot(b[0] - a[0], b[1] - a[1]))
        if facade[-1] > 0.1:
            facade_quad(faces, facade, 0, facade[-1], base_y, min_y + 0.55, STONE, out=0.055)
            if building['id'] in STONE_RETURN_IDS and facade[-1] >= 4.2:
                top_at_a = top_a
                top_at_b = top_b
                facade_quad(faces, facade, 0.03, 0.22, base_y, top_at_a, STONE, out=0.075)
                facade_quad(faces, facade, facade[-1] - 0.22, facade[-1] - 0.03, base_y, top_at_b, STONE, out=0.075)

    roof_y = build_roof(points, faces, axis, top_y, rise, roof, gable)
    facades = []
    ccw = signed_area(points) > 0
    for i, a in enumerate(points):
        b = points[(i + 1) % len(points)]
        dx, dz = b[0] - a[0], b[1] - a[1]
        length = math.hypot(dx, dz)
        if length < 2:
            continue
        nx, nz = ((dz, -dx) if ccw else (-dz, dx))
        nx, nz = nx / length, nz / length
        facades.append((a[0], a[1], b[0], b[1], nx, nz, length, i))

    def facing_spawn(facade):
        ax, az, bx, bz, nx, nz, _, _ = facade
        vx, vz = SPAWN[0] - (ax + bx) / 2, SPAWN[1] - (az + bz) / 2
        distance = math.hypot(vx, vz) or 1
        return (nx * vx + nz * vz) / distance

    preferred = [f for f in facades if facing_spawn(f) > 0.3]
    main = max(preferred or facades, key=lambda f: f[6]) if facades else None
    if main:
        ax, az, bx, bz, nx, nz, length, _ = main
        facade = (ax, az, bx, bz, nx, nz, length)
        door_width = 0.95
        s = length / 2
        y0 = terrain_height_at(terrain_samplers, terrain_config, ax + (bx - ax) * 0.5, az + (bz - az) * 0.5) + 0.03
        y1 = y0 + 2.0
        facade_quad(faces, facade, s - door_width / 2, s + door_width / 2, y0, y1, WOOD, 0.1)
        for side in (-1, 1):
            facade_quad(faces, facade, s + side * (door_width / 2 + 0.025), s + side * (door_width / 2 + 0.1), y0, y1 + 0.05, TRIM, 0.13)
        facade_quad(faces, facade, s - door_width / 2 - 0.1, s + door_width / 2 + 0.1, y1 + 0.04, y1 + 0.14, TRIM, 0.13)

    ordered = sorted(facades, key=lambda f: max(0, facing_spawn(f)), reverse=True)
    for facade_data in ordered[:3]:
        ax, az, bx, bz, nx, nz, length, _ = facade_data
        facade = (ax, az, bx, bz, nx, nz, length)
        windows_per_floor = 2 if length >= 3.2 else 1
        for floor in range(3):
            y0 = min_y + 1.15 + floor * 3
            y1 = y0 + 0.95
            if y1 > top_y - 0.1:
                continue
            for w in range(windows_per_floor):
                center_s = length * (0.2 if w == 0 else 0.8) if windows_per_floor == 2 else length / 2
                if facade_data is main and floor == 0 and abs(center_s - length / 2) < 0.75:
                    continue
                half_w = 0.35
                facade_quad(faces, facade, center_s - half_w, center_s + half_w, y0, y1, GLASS, 0.1)
                for side in (-1, 1):
                    facade_quad(faces, facade, center_s + side * 0.39, center_s + side * 0.47, y0 - 0.04, y1 + 0.04, TRIM, 0.12)
                    facade_quad(faces, facade, center_s + side * 0.53, center_s + side * 0.67, y0 - 0.02, y1 + 0.02, WOOD, 0.16)
                facade_quad(faces, facade, center_s - 0.47, center_s + 0.47, y0 - 0.11, y0 - 0.04, TRIM, 0.12)
                if y1 + 0.12 < top_y:
                    facade_quad(faces, facade, center_s - 0.47, center_s + 0.47, y1 + 0.04, y1 + 0.12, TRIM, 0.12)

    if building['id'] in CHIMNEY_IDS and gable and area >= 35 and half_u >= 2:
        cx = axis[0][0] + axis[1][0] * (half_u * 0.45)
        cz = axis[0][1] + axis[1][1] * (half_u * 0.45)
        side = (-axis[1][1], axis[1][0])
        corners = [
            (cx - axis[1][0] * 0.3 - side[0] * 0.25, cz - axis[1][1] * 0.3 - side[1] * 0.25),
            (cx + axis[1][0] * 0.3 - side[0] * 0.25, cz + axis[1][1] * 0.3 - side[1] * 0.25),
            (cx + axis[1][0] * 0.3 + side[0] * 0.25, cz + axis[1][1] * 0.3 + side[1] * 0.25),
            (cx - axis[1][0] * 0.3 + side[0] * 0.25, cz - axis[1][1] * 0.3 + side[1] * 0.25),
        ]
        bottom, top = top_y + rise - 0.25, top_y + rise + 1.2
        for i, a in enumerate(corners):
            b = corners[(i + 1) % 4]
            faces.quad((a[0], bottom, a[1]), (b[0], bottom, b[1]), (b[0], top, b[1]), (a[0], top, a[1]), STONE)
        faces.quad(
            (corners[0][0], top, corners[0][1]),
            (corners[1][0], top, corners[1][1]),
            (corners[2][0], top, corners[2][1]),
            (corners[3][0], top, corners[3][1]),
            (0.48, 0.40, 0.34),
        )

    return faces, height, min_y, lidar_samples, lidar_roof, area


def color_material():
    mat = bpy.data.materials.new('Montes de Oca | colores por vértice')
    mat.diffuse_color = (0.8, 0.7, 0.55, 1.0)
    mat.use_nodes = True
    mat.use_backface_culling = False
    nodes = mat.node_tree.nodes
    bsdf = nodes.get('Principled BSDF')
    vertex_color = nodes.new('ShaderNodeVertexColor')
    vertex_color.layer_name = 'Color'
    mat.node_tree.links.new(vertex_color.outputs['Color'], bsdf.inputs['Base Color'])
    return mat


def make_mesh_object(name, geometry, collection, material):
    mesh = bpy.data.meshes.new(name + ' | mesh')
    mesh.from_pydata(geometry.vertices, [], geometry.faces)
    mesh.update()
    color = mesh.color_attributes.new(name='Color', type='FLOAT_COLOR', domain='POINT')
    for index, rgba in enumerate(geometry.colors):
        color.data[index].color = rgba
    obj = bpy.data.objects.new(name, mesh)
    obj.data.materials.append(material)
    collection.objects.link(obj)
    return obj


def main():
    os.makedirs(BLEND_FILE.parent, exist_ok=True)
    GLB_FILE.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete(use_global=False)
    for collection in list(bpy.data.collections):
        if collection.name != 'Collection' and collection.users == 0:
            bpy.data.collections.remove(collection)
    root_collection = bpy.context.scene.collection
    pilot_collection = bpy.data.collections.new('Piloto de casas | OSM + IGN')
    root_collection.children.link(pilot_collection)

    buildings_doc = read_json(BUILDINGS_FILE)
    buildings = {item['id']: item for item in buildings_doc['buildings']}
    raw = read_json(RAW_OSM_FILE)
    ways = {item['id']: item for item in raw['elements']}
    height_doc = read_json(HEIGHT_GRID_FILE)
    grid = height_doc['grid']
    packed = (ROOT / 'public/village' / height_doc['valuesFile']).read_bytes()
    values = struct.unpack('<%dh' % (grid['width'] * grid['height']), packed)
    terrain_config = read_json(TERRAIN_CONFIG_FILE)
    samplers = load_terrain_samplers(terrain_config)
    mat = color_material()
    source_objects = []
    records = []
    triangle_count = 0

    for osm_id in PILOT_IDS:
        building = buildings[osm_id]
        tags = ways[osm_id].get('tags', {})
        geometry, height, min_y, lidar_samples, lidar_roof, footprint_area = build_building(
            building, tags, samplers, terrain_config, grid, values
        )
        obj = make_mesh_object('osm-way-%d' % osm_id, geometry, pilot_collection, mat)
        obj['osm_way_id'] = osm_id
        obj['height_source'] = 'IGN MDSnE P95' if lidar_samples >= MIN_LIDAR_SAMPLES else building['heightSource']
        obj['facade_source'] = 'reconstruccion estilizada aproximada'
        source_objects.append(obj)
        triangles = sum(len(face) - 2 for face in geometry.faces)
        triangle_count += triangles
        _, (ux, uz), half_u, half_v = principal_axis([tuple(point) for point in building['footprint']])
        records.append({
            'osmWayId': osm_id,
            'building': tags.get('building'),
            'levels': tags.get('building:levels'),
            'heightSource': 'lidar' if lidar_samples >= MIN_LIDAR_SAMPLES else building['heightSource'],
            'heightM': round(height, 3),
            'baseY': round(min_y - FALDON_M, 4),
            'footprintAreaM2': round(footprint_area, 1),
            'lidarSampleCount': lidar_samples,
            'lidarRoofP95M': lidar_roof,
            'bodyKindHeuristic': building['materialKind'],
            'roofKindHeuristic': building['roofKind'],
            'roofShape': 'gable' if roof_is_gable(osm_id, half_u, half_v) else 'hip',
            'ridgeAzimuthDeg': round(math.degrees(math.atan2(uz, ux)), 1),
            'facadeTreatment': 'reconstruccion estilizada aproximada',
            'triangles': triangles,
        })

    # Keep eight independently editable source objects in .blend; join temporary
    # copies for a single draw-call GLB with vertex colors.
    bpy.ops.object.select_all(action='DESELECT')
    for obj in source_objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = source_objects[0]
    bpy.ops.wm.save_as_mainfile(filepath=str(BLEND_FILE))
    bpy.ops.object.duplicate()
    bpy.ops.object.join()
    joined = bpy.context.view_layer.objects.active
    joined.name = 'pueblo:pilot-houses:batched'
    joined.data.name = joined.name + ' | mesh'
    joined['pilot_osm_way_ids'] = ','.join(str(value) for value in PILOT_IDS)
    bpy.ops.export_scene.gltf(
        filepath=str(GLB_FILE),
        export_format='GLB',
        export_yup=True,
        use_selection=True,
        export_animations=False,
        export_cameras=False,
        export_lights=False,
        export_colors=True,
        export_materials='EXPORT',
        export_apply=True,
    )

    digest = hashlib.sha256(GLB_FILE.read_bytes()).hexdigest()
    manifest = {
        'schemaVersion': 1,
        'generatedBy': 'scripts/environment/build_village_pilot.py',
        'coordinateSystem': 'Blender X=east,Y=north,Z=up; GLB exported Y-up for Babylon.js',
        'osmLicense': 'ODbL-1.0 (OpenStreetMap contributors)',
        'ignLicense': 'CC BY 4.0 (IGN/CNIG)',
        'facadeStatus': 'approximate stylized reconstruction; no surveyed facade photos were used for individual houses',
        'glb': {
            'file': GLB_FILE.name,
            'bytes': GLB_FILE.stat().st_size,
            'sha256': digest,
            'triangles': triangle_count,
            'meshCount': 1,
        },
        'blend': os.path.relpath(BLEND_FILE, ROOT),
        'buildings': records,
    }
    MANIFEST_FILE.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf8')
    print('[village-pilot] %d edificios, %d triangulos, %d bytes' % (len(records), triangle_count, GLB_FILE.stat().st_size))
    print('[village-pilot] blend: %s' % BLEND_FILE)
    print('[village-pilot] glb: %s' % GLB_FILE)


main()
