#!/usr/bin/env python3
"""Build small, texture-free Blender assets for the church and plaza."""
import hashlib
import json
import math
import sys
import tempfile
from pathlib import Path

import bpy

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / 'assets/environment/focal-sites/sites.json'
BUILDINGS = ROOT / 'public/village/buildings.json'
ROADS = ROOT / 'public/roads/roads.json'
BLEND = ROOT / 'assets/environment/focal-sites/focal-sites.blend'
OUT = ROOT / 'public/village/focal-sites'

STONE = (0.43, 0.40, 0.34, 1.0)
STONE_LIGHT = (0.53, 0.49, 0.42, 1.0)
STONE_SHADE = (0.32, 0.29, 0.24, 1.0)
ROOF = (0.26, 0.075, 0.034, 1.0)
ROOF_LIGHT = (0.32, 0.105, 0.048, 1.0)
ROOF_SHADE = (0.18, 0.042, 0.021, 1.0)
DARK = (0.12, 0.12, 0.11, 1.0)
STONE_PAVING = (0.105, 0.085, 0.058, 1.0)
STONE_PAVING_LIGHT = (0.14, 0.115, 0.078, 1.0)
WOOD = (0.32, 0.23, 0.15, 1.0)
WOOD_LIGHT = (0.44, 0.33, 0.22, 1.0)
METAL = (0.20, 0.21, 0.19, 1.0)


class MeshBatch:
    def __init__(self):
        self.vertices = []
        self.faces = []
        self.colors = []
        self.vertex_indices = {}
        self.face_indices = set()

    def face(self, points, color):
        indices = []
        for point in points:
            key = tuple(round(component, 6) for component in point)
            index = self.vertex_indices.get(key)
            if index is None:
                index = len(self.vertices)
                self.vertex_indices[key] = index
                self.vertices.append(point)
            indices.append(index)
        face_key = tuple(sorted(indices))
        if face_key in self.face_indices:
            return
        self.face_indices.add(face_key)
        self.faces.append(tuple(indices))
        self.colors.append(color)

    def box(self, x, y, z, sx, sy, sz, color, top=None):
        x0, x1 = x - sx / 2, x + sx / 2
        y0, y1 = y - sy / 2, y + sy / 2
        z0, z1 = z - sz / 2, z + sz / 2
        self.face([(x0, y0, z0), (x1, y0, z0), (x1, y0, z1), (x0, y0, z1)], color)
        self.face([(x1, y1, z0), (x0, y1, z0), (x0, y1, z1), (x1, y1, z1)], color)
        self.face([(x0, y1, z0), (x0, y0, z0), (x0, y0, z1), (x0, y1, z1)], color)
        self.face([(x1, y0, z0), (x1, y1, z0), (x1, y1, z1), (x1, y0, z1)], color)
        self.face([(x0, y0, z0), (x0, y1, z0), (x1, y1, z0), (x1, y0, z0)], color)
        self.face([(x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1)], top or color)

    def vertical_prism(self, cx, cy, radius, sides, z0, z1, color):
        lower = []
        upper = []
        for i in range(sides):
            angle = math.tau * i / sides + math.pi / 8
            lower.append((cx + math.cos(angle) * radius, cy + math.sin(angle) * radius, z0))
            upper.append((cx + math.cos(angle) * radius, cy + math.sin(angle) * radius, z1))
        for i in range(sides):
            j = (i + 1) % sides
            self.face([lower[i], lower[j], upper[j], upper[i]], color if i % 2 else STONE_LIGHT)
        self.face(lower, STONE_SHADE)
        self.face(upper, color)

    def cylinder_y(self, cx, cy, cz, radius, depth, sides, color):
        left = []
        right = []
        for i in range(sides):
            angle = math.tau * i / sides
            dz = math.sin(angle) * radius
            dx = math.cos(angle) * radius
            left.append((cx + dx, cy - depth / 2, cz + dz))
            right.append((cx + dx, cy + depth / 2, cz + dz))
        self.face(left, color)
        self.face(list(reversed(right)), color)
        for i in range(sides):
            j = (i + 1) % sides
            self.face([left[i], left[j], right[j], right[i]], color)

    def create_object(self, name, collection):
        mesh = bpy.data.meshes.new(f'{name}:mesh')
        mesh.from_pydata(self.vertices, [], self.faces)
        mesh.update()
        colors = mesh.color_attributes.new(name='Color', type='BYTE_COLOR', domain='CORNER')
        for polygon, color in zip(mesh.polygons, self.colors):
            for loop_index in polygon.loop_indices:
                colors.data[loop_index].color = color
        material = bpy.data.materials.new(f'{name}:vertex-colors')
        material.diffuse_color = (1, 1, 1, 1)
        material.use_nodes = True
        bsdf = material.node_tree.nodes.get('Principled BSDF')
        if bsdf:
            bsdf.inputs['Base Color'].default_value = (1, 1, 1, 1)
            bsdf.inputs['Roughness'].default_value = 0.9
        mesh.materials.append(material)
        obj = bpy.data.objects.new(name, mesh)
        collection.objects.link(obj)
        obj['draw_call_budget'] = 1
        obj['reconstruction'] = 'stylized low-poly approximation'
        return obj


def load_json(path):
    with path.open(encoding='utf8') as stream:
        return json.load(stream)


def wgs84_to_world(lon, lat, bounds_e=471500.0, bounds_n=4689000.0):
    """Match src/config.ts: WGS84 to EPSG:25830, then subtract world origin."""
    a = 6378137.0
    e2 = 0.0066943799901413165
    ep2 = e2 / (1 - e2)
    k0 = 0.9996
    phi = math.radians(lat)
    lam = math.radians(lon)
    lam0 = math.radians(-3.0)
    sin_phi, cos_phi, tan_phi = math.sin(phi), math.cos(phi), math.tan(phi)
    n = a / math.sqrt(1 - e2 * sin_phi * sin_phi)
    t = tan_phi * tan_phi
    c = ep2 * cos_phi * cos_phi
    aa = cos_phi * (lam - lam0)
    e4, e6 = e2 * e2, e2 * e2 * e2
    m = a * (
        (1 - e2 / 4 - 3 * e4 / 64 - 5 * e6 / 256) * phi
        - (3 * e2 / 8 + 3 * e4 / 32 + 45 * e6 / 1024) * math.sin(2 * phi)
        + (15 * e4 / 256 + 45 * e6 / 1024) * math.sin(4 * phi)
        - (35 * e6 / 3072) * math.sin(6 * phi)
    )
    easting = 500000 + k0 * n * (
        aa + (1 - t + c) * aa ** 3 / 6
        + (5 - 18 * t + t * t + 72 * c - 58 * ep2) * aa ** 5 / 120
    )
    northing = k0 * (m + n * tan_phi * (
        aa * aa / 2 + (5 - t + 9 * c + 4 * c * c) * aa ** 4 / 24
        + (61 - 58 * t + t * t + 600 * c - 330 * ep2) * aa ** 6 / 720
    ))
    return easting - bounds_e, northing - bounds_n


def polygon_centroid(points):
    cross = [points[i][0] * points[(i + 1) % len(points)][1] - points[(i + 1) % len(points)][0] * points[i][1] for i in range(len(points))]
    area2 = sum(cross)
    if abs(area2) < 1e-8:
        return (sum(p[0] for p in points) / len(points), sum(p[1] for p in points) / len(points))
    x = sum((points[i][0] + points[(i + 1) % len(points)][0]) * cross[i] for i in range(len(points))) / (3 * area2)
    z = sum((points[i][1] + points[(i + 1) % len(points)][1]) * cross[i] for i in range(len(points))) / (3 * area2)
    return x, z


def localize(points, anchor):
    return [(x - anchor[0], z - anchor[1]) for x, z in points]


def add_polygon_walls(batch, points, height, base=0.0):
    for i, (x0, y0) in enumerate(points):
        x1, y1 = points[(i + 1) % len(points)]
        batch.face([(x0, y0, base), (x1, y1, base), (x1, y1, height), (x0, y0, height)], STONE if i % 3 else STONE_LIGHT)


def add_gable_roof(batch, xmin, xmax, ymin, ymax, eaves, ridge, color):
    ym = (ymin + ymax) / 2
    batch.face([(xmin, ymin, eaves), (xmax, ymin, eaves), (xmax, ym, ridge), (xmin, ym, ridge)], color)
    batch.face([(xmax, ymax, eaves), (xmin, ymax, eaves), (xmin, ym, ridge), (xmax, ym, ridge)], ROOF_LIGHT)
    batch.face([(xmin, ymin, eaves), (xmin, ymax, eaves), (xmin, ym, ridge)], ROOF)
    batch.face([(xmax, ymax, eaves), (xmax, ymin, eaves), (xmax, ym, ridge)], color)


def add_gable_roof_north_south(batch, xmin, xmax, ymin, ymax, eaves, ridge, color):
    """Two roof planes with a north-south ridge (Blender local Y)."""
    xm = (xmin + xmax) / 2
    batch.face([(xmin, ymin, eaves), (xm, ymin, ridge), (xm, ymax, ridge), (xmin, ymax, eaves)], color)
    batch.face([(xmax, ymin, eaves), (xmax, ymax, eaves), (xm, ymax, ridge), (xm, ymin, ridge)], ROOF_LIGHT)
    batch.face([(xmin, ymin, eaves), (xmin, ymax, eaves), (xm, ymax, ridge)], ROOF_SHADE)
    batch.face([(xmax, ymax, eaves), (xmax, ymin, eaves), (xm, ymin, ridge)], color)


def add_gable_end_x(batch, x, ymin, ymax, eaves, ridge, color):
    ym = (ymin + ymax) / 2
    batch.face([(x, ymin, eaves), (x, ymax, eaves), (x, ym, ridge)], color)


def add_gable_end_y(batch, y, xmin, xmax, eaves, ridge, color):
    xm = (xmin + xmax) / 2
    batch.face([(xmin, y, eaves), (xmax, y, eaves), (xm, y, ridge)], color)


def add_window_y(batch, cx, y, sill, width=1.25, height=1.55):
    """Small stone-framed window on the camera-side north facade."""
    half = width / 2
    left, right = cx - half, cx + half
    top = sill + height
    batch.face([(left + 0.12, y, sill + 0.12), (left + 0.12, y, top - 0.12),
                (right - 0.12, y, top - 0.12), (right - 0.12, y, sill + 0.12)], DARK)
    frame = STONE_LIGHT
    batch.face([(left, y - 0.015, sill), (left, y - 0.015, top),
                (left + 0.12, y - 0.015, top), (left + 0.12, y - 0.015, sill)], frame)
    batch.face([(right - 0.12, y - 0.015, sill), (right - 0.12, y - 0.015, top),
                (right, y - 0.015, top), (right, y - 0.015, sill)], frame)
    batch.face([(left, y - 0.015, top - 0.12), (left, y - 0.015, top),
                (right, y - 0.015, top), (right, y - 0.015, top - 0.12)], frame)
    batch.face([(left - 0.08, y - 0.045, sill - 0.08), (right + 0.08, y - 0.045, sill - 0.08),
                (right + 0.08, y - 0.045, sill), (left - 0.08, y - 0.045, sill)], STONE_LIGHT)
    batch.face([(cx - 0.035, y - 0.025, sill + 0.12), (cx + 0.035, y - 0.025, sill + 0.12),
                (cx + 0.035, y - 0.025, top - 0.12), (cx - 0.035, y - 0.025, top - 0.12)], STONE_SHADE)


def add_portal_y(batch, cx, y, width=2.2, height=2.9):
    """Stone portal and timber door on the visible gable end."""
    left, right = cx - width / 2, cx + width / 2
    batch.face([(left + 0.14, y, 0.08), (left + 0.14, y, height - 0.15),
                (right - 0.14, y, height - 0.15), (right - 0.14, y, 0.08)], WOOD)
    batch.face([(left - 0.12, y - 0.02, 0.0), (left - 0.12, y - 0.02, height),
                (left + 0.14, y - 0.02, height), (left + 0.14, y - 0.02, 0.0)], STONE_LIGHT)
    batch.face([(right - 0.14, y - 0.02, 0.0), (right - 0.14, y - 0.02, height),
                (right + 0.12, y - 0.02, height), (right + 0.12, y - 0.02, 0.0)], STONE_LIGHT)
    batch.face([(left - 0.12, y - 0.02, height - 0.18), (left - 0.12, y - 0.02, height),
                (right + 0.12, y - 0.02, height), (right + 0.12, y - 0.02, height - 0.18)], STONE_LIGHT)
    batch.face([(cx - 0.035, y - 0.035, 0.1), (cx + 0.035, y - 0.035, 0.1),
                (cx + 0.035, y - 0.035, height - 0.15), (cx - 0.035, y - 0.035, height - 0.15)], WOOD_LIGHT)
    batch.box(cx + 0.48, y - 0.07, 1.0, 0.09, 0.08, 0.09, STONE_LIGHT)


def add_stone_course_relief(batch, xmin, xmax, y):
    """Shallow masonry joints for a more legible dressed-stone facade."""
    for course, z in enumerate((0.62, 1.55, 2.48, 3.41, 4.34, 5.27)):
        batch.face([(xmin, y, z), (xmin, y, z + 0.025), (xmax, y, z + 0.025), (xmax, y, z)], STONE_SHADE)
        x = xmin + (1.25 if course % 2 else 0.0)
        while x < xmax:
            batch.face([(x, y, z), (x, y + 0.005, z + 0.9),
                        (x + 0.035, y + 0.005, z + 0.9), (x + 0.035, y, z)], STONE_SHADE)
            x += 2.5


def add_arch_mark(batch, center, plane, axis, width=1.0, spring=10.5, radius=0.72, base=8.35):
    """A dark, segmented bell opening with a light stone arch, on one tower face."""
    cx, cy = center
    if axis == 'x':
        point = lambda offset, height: (cx + offset, plane, height)
    else:
        point = lambda offset, height: (plane, cy + offset, height)
    arch = [(radius * math.cos(math.pi * i / 8), spring + radius * math.sin(math.pi * i / 8)) for i in range(9)]
    opening = [(-width / 2, base), (width / 2, base), (width / 2, spring)] + arch[1:-1] + [(-width / 2, spring)]
    batch.face([point(offset, height) for offset, height in opening], DARK)
    # voussoirs: eight short stone wedges make the arch legible at plaza scale.
    for index in range(8):
        a0 = math.pi * index / 8
        a1 = math.pi * (index + 1) / 8
        outer = radius + 0.16
        batch.face([
            point(radius * math.cos(a0), spring + radius * math.sin(a0)),
            point(radius * math.cos(a1), spring + radius * math.sin(a1)),
            point(outer * math.cos(a1), spring + outer * math.sin(a1)),
            point(outer * math.cos(a0), spring + outer * math.sin(a0)),
        ], STONE_LIGHT if index % 2 == 0 else STONE)


def make_church(building, collection):
    footprint = building['footprint']
    anchor = polygon_centroid(footprint)
    points = localize(footprint, anchor)
    xmin = min(p[0] for p in points)
    xmax = max(p[0] for p in points)
    ymin = min(p[1] for p in points)
    ymax = max(p[1] for p in points)
    batch = MeshBatch()
    # OSM footprint and the existing type-derived wall estimate remain authoritative.
    add_polygon_walls(batch, points, 5.8)
    # PNOA 2023 shows crossing ridges: the north-south nave meets the east-west
    # transept. The photograph is used only for the low-poly visual read; no
    # photographic pixels or unverified façade dimensions are carried over.
    center_x = (xmin + xmax) / 2
    center_y = (ymin + ymax) / 2
    nave_half_width = min(7.2, (xmax - xmin) * 0.23)
    transept_half_depth = min(6.0, (ymax - ymin) * 0.27)
    roof_eaves = 6.05
    roof_ridge = 8.75
    add_gable_roof_north_south(
        batch, center_x - nave_half_width, center_x + nave_half_width,
        ymin + 0.8, ymax - 0.8, roof_eaves, roof_ridge, ROOF,
    )
    add_gable_roof(
        batch, xmin + 0.8, xmax - 0.8,
        center_y - transept_half_depth, center_y + transept_half_depth,
        roof_eaves, roof_ridge, ROOF_SHADE,
    )
    add_gable_end_y(batch, ymin + 0.8, center_x - nave_half_width, center_x + nave_half_width, roof_eaves, roof_ridge, ROOF)
    add_gable_end_y(batch, ymax - 0.8, center_x - nave_half_width, center_x + nave_half_width, roof_eaves, roof_ridge, ROOF_LIGHT)
    add_gable_end_x(batch, xmin + 0.8, center_y - transept_half_depth, center_y + transept_half_depth, roof_eaves, roof_ridge, ROOF_SHADE)
    add_gable_end_x(batch, xmax - 0.8, center_y - transept_half_depth, center_y + transept_half_depth, roof_eaves, roof_ridge, ROOF)

    # Broad stone courses and a quiet cornice break up the uninterrupted wall.
    for h in (0.38, 5.55):
        for i, (x0, y0) in enumerate(points):
            x1, y1 = points[(i + 1) % len(points)]
            batch.face([(x0, y0, h), (x1, y1, h), (x1, y1, h + 0.12), (x0, y0, h + 0.12)], STONE_LIGHT if i % 2 else STONE)

    # Bell tower at the west end. Its belfry, cupola and cross rise clearly above
    # the nave; the silhouette is an approximate visual proportion, not a survey.
    tx = xmin + 5.2
    ty = center_y
    tw = 6.3
    half = tw / 2
    tower_lift = 5.2
    batch.box(tx, ty, 4.0, tw, tw, 8.0, STONE, STONE_LIGHT)
    # The solid square shaft deliberately projects above the crossing nave roof
    # before the open bell stage begins. The supplied plaza photo shows the clock
    # well above the nave ridge; extend the shaft instead of floating the belfry.
    batch.box(tx, ty, 9.45 + tower_lift / 2, tw, tw, 2.9 + tower_lift, STONE, STONE_LIGHT)
    # Give the lengthened shaft a readable stone rhythm and corner definition
    # so it does not read as one blank slab at the fixed village camera distance.
    for z in (9.85, 11.65, 13.45, 15.25):
        batch.box(tx, ty - half - 0.035, z, tw - 0.22, 0.12, 0.11, STONE)
        batch.box(tx, ty + half + 0.035, z, tw - 0.22, 0.12, 0.11, STONE)
        batch.box(tx - half - 0.035, ty, z, 0.12, tw - 0.22, 0.11, STONE)
        batch.box(tx + half + 0.035, ty, z, 0.12, tw - 0.22, 0.11, STONE)
    for dx in (-half + 0.22, half - 0.22):
        batch.box(tx + dx, ty - half - 0.045, 12.2, 0.18, 0.1, 7.4, STONE)
        batch.box(tx + dx, ty + half + 0.045, 12.2, 0.18, 0.1, 7.4, STONE)
    for dy in (-half + 0.22, half - 0.22):
        batch.box(tx - half - 0.045, ty + dy, 12.2, 0.1, 0.18, 7.4, STONE)
        batch.box(tx + half + 0.045, ty + dy, 12.2, 0.1, 0.18, 7.4, STONE)
    for dx in (-half + 0.28, 0, half - 0.28):
        batch.box(tx + dx, ty - half - 0.03, 12.2 + tower_lift, 0.28, 0.2, 2.45, STONE_LIGHT)
        batch.box(tx + dx, ty + half + 0.03, 12.2 + tower_lift, 0.28, 0.2, 2.45, STONE_LIGHT)
    for dy in (-half + 0.28, 0, half - 0.28):
        batch.box(tx - half - 0.03, ty + dy, 12.2 + tower_lift, 0.2, 0.28, 2.45, STONE_LIGHT)
        batch.box(tx + half + 0.03, ty + dy, 12.2 + tower_lift, 0.2, 0.28, 2.45, STONE_LIGHT)
    for side_y in (ty - half - 0.12, ty + half + 0.12):
        for dx in (-1.45, 1.45):
            add_arch_mark(batch, (tx + dx, ty), side_y, 'x', spring=12.2 + tower_lift, radius=0.72, base=11.05 + tower_lift)
    for side_x in (tx - half - 0.12, tx + half + 0.12):
        for dy in (-1.45, 1.45):
            add_arch_mark(batch, (tx, ty + dy), side_x, 'y', spring=12.2 + tower_lift, radius=0.72, base=11.05 + tower_lift)
    # Cornices frame the belfry and separate it from the cupola drum.
    batch.box(tx, ty, 8.15, tw + 0.48, tw + 0.48, 0.34, STONE_LIGHT)
    batch.box(tx, ty, 10.9 + tower_lift, tw + 0.52, tw + 0.52, 0.34, STONE_LIGHT)
    batch.box(tx, ty, 13.45 + tower_lift, tw + 0.52, tw + 0.52, 0.34, STONE_LIGHT)
    batch.vertical_prism(tx, ty, 2.75, 8, 13.65 + tower_lift, 14.32 + tower_lift, STONE_LIGHT)
    lower = []
    upper = []
    for i in range(8):
        a = math.tau * i / 8 + math.pi / 8
        lower.append((tx + math.cos(a) * 2.72, ty + math.sin(a) * 2.72, 14.3 + tower_lift))
        upper.append((tx + math.cos(a) * 0.72, ty + math.sin(a) * 0.72, 16.0 + tower_lift))
    for i in range(8):
        j = (i + 1) % 8
        batch.face([lower[i], lower[j], upper[j], upper[i]], ROOF if i % 2 else ROOF_LIGHT)
    batch.face(upper, ROOF)
    batch.vertical_prism(tx, ty, 0.73, 8, 15.95 + tower_lift, 16.22 + tower_lift, STONE_LIGHT)
    batch.box(tx, ty, 16.55 + tower_lift, 0.14, 0.14, 0.48, STONE_LIGHT)
    batch.box(tx, ty, 16.78 + tower_lift, 0.72, 0.14, 0.12, STONE_LIGHT)

    # Camera-facing north portal, timber door and clock; these are stylized details.
    front_y = ty + half + 0.08
    door = [(tx - 0.95, front_y, 0.0), (tx - 0.95, front_y, 2.45), (tx + 0.95, front_y, 2.45), (tx + 0.95, front_y, 0.0)]
    batch.face(door, DARK)
    batch.face([(tx - 1.12, front_y + 0.03, 0.12), (tx - 1.12, front_y + 0.03, 2.55), (tx - 1.0, front_y + 0.03, 2.55), (tx - 1.0, front_y + 0.03, 0.12)], STONE_LIGHT)
    batch.face([(tx + 1.0, front_y + 0.03, 0.12), (tx + 1.0, front_y + 0.03, 2.55), (tx + 1.12, front_y + 0.03, 2.55), (tx + 1.12, front_y + 0.03, 0.12)], STONE_LIGHT)
    clock_y = ty + half + 0.14
    clock_z = 9.45 + tower_lift
    batch.cylinder_y(tx, clock_y, clock_z, 0.72, 0.05, 16, STONE_LIGHT)
    batch.cylinder_y(tx, clock_y + 0.04, clock_z, 0.60, 0.03, 16, (0.84, 0.82, 0.74, 1.0))
    batch.box(tx, clock_y + 0.065, clock_z, 0.045, 0.035, 0.72, DARK)
    batch.box(tx + 0.15, clock_y + 0.07, clock_z + 0.1, 0.34, 0.035, 0.045, DARK)
    for angle in range(0, 360, 45):
        a = math.radians(angle)
        batch.box(tx + math.sin(a) * 0.49, clock_y + 0.055, clock_z + math.cos(a) * 0.49,
                  0.055, 0.025, 0.055, DARK)

    # Readable church portal, windows and shallow dressed-stone joints on the
    # north gable captured by the fixed game camera.
    gable_y = ymax + 0.05
    add_stone_course_relief(batch, xmin + 9.0, xmax - 0.8, gable_y - 0.015)
    add_portal_y(batch, center_x + 4.2, gable_y + 0.035, width=2.25, height=2.9)
    add_window_y(batch, center_x - 5.8, gable_y + 0.035, 2.15, width=1.25, height=1.55)
    add_window_y(batch, center_x + 10.1, gable_y + 0.035, 2.15, width=1.25, height=1.55)

    obj = batch.create_object('focal:church', collection)
    obj['osm_way_id'] = 90614388
    obj['height_reference_m'] = 12.8
    obj['height_source'] = 'type-derived from four floors; not LiDAR; tower silhouette rises beyond this reference as a photo-informed approximation'
    obj['tower_height_note'] = 'tower apex is a visual proportion, not a measured height'
    obj['footprint_source'] = 'public/village/buildings.json'
    obj['photo_reference'] = 'Gerd Eichmann, CC BY-SA 4.0; user-provided fotos/Iglesia_plaza.jpg (author, license and date unknown)'
    obj['roof_evidence'] = 'PNOA MA 2023: crossed N-S nave and E-W transept ridges'
    obj['reconstruction_note'] = 'Tower height and details are stylized visual interpretation; no photo pixels included'
    return obj, anchor


def inside_polygon(point, polygon):
    inside = False
    j = len(polygon) - 1
    for i, a in enumerate(polygon):
        b = polygon[j]
        if ((a[1] > point[1]) != (b[1] > point[1])) and point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]:
            inside = not inside
        j = i
    return inside


def distance_to_polyline(point, line):
    best = float('inf')
    for a, b in zip(line, line[1:]):
        dx, dy = b[0] - a[0], b[1] - a[1]
        scale = max(0.0, min(1.0, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / (dx * dx + dy * dy or 1.0)))
        best = min(best, math.hypot(point[0] - a[0] - scale * dx, point[1] - a[1] - scale * dy))
    return best


def clip_polygon_to_rect(polygon, xmin, xmax, zmin, zmax):
    """Clip one small boundary-cell piece of a mapped polygon to its grid cell."""
    result = polygon[:]
    boundaries = (
        (lambda p: p[0] >= xmin, lambda a, b: (xmin, a[1] + (b[1] - a[1]) * (xmin - a[0]) / (b[0] - a[0]))),
        (lambda p: p[0] <= xmax, lambda a, b: (xmax, a[1] + (b[1] - a[1]) * (xmax - a[0]) / (b[0] - a[0]))),
        (lambda p: p[1] >= zmin, lambda a, b: (a[0] + (b[0] - a[0]) * (zmin - a[1]) / (b[1] - a[1]), zmin)),
        (lambda p: p[1] <= zmax, lambda a, b: (a[0] + (b[0] - a[0]) * (zmax - a[1]) / (b[1] - a[1]), zmax)),
    )
    for inside, intersect in boundaries:
        if not result:
            break
        source, result = result, []
        previous = source[-1]
        previous_inside = inside(previous)
        for current in source:
            current_inside = inside(current)
            if current_inside != previous_inside:
                result.append(intersect(previous, current))
            if current_inside:
                result.append(current)
            previous, previous_inside = current, current_inside
    cleaned = []
    for point in result:
        if not cleaned or math.dist(point, cleaned[-1]) > 1e-7:
            cleaned.append(point)
    if len(cleaned) > 1 and math.dist(cleaned[0], cleaned[-1]) <= 1e-7:
        cleaned.pop()
    return cleaned


def clip_polygon_to_road_edge(polygon, road, side, clearance):
    """Remove the road corridor with a straight, exact offset edge for a two-node way."""
    a, b = road[0], road[-1]
    dx, dz = b[0] - a[0], b[1] - a[1]
    length = math.hypot(dx, dz) or 1.0

    def signed_distance(point):
        longitudinal = ((point[0] - a[0]) * dx + (point[1] - a[1]) * dz) / (length * length)
        width = clearance(longitudinal, side) if callable(clearance) else clearance
        return side * (dx * (point[1] - a[1]) - dz * (point[0] - a[0])) / length - width

    result = []
    previous = polygon[-1]
    previous_value = signed_distance(previous)
    for current in polygon:
        current_value = signed_distance(current)
        previous_inside, current_inside = previous_value >= -1e-8, current_value >= -1e-8
        if previous_inside != current_inside:
            t = previous_value / (previous_value - current_value)
            result.append((previous[0] + (current[0] - previous[0]) * t,
                           previous[1] + (current[1] - previous[1]) * t))
        if current_inside:
            result.append(current)
        previous, previous_value = current, current_value
    cleaned = []
    for point in result:
        if not cleaned or math.dist(point, cleaned[-1]) > 1e-7:
            cleaned.append(point)
    if len(cleaned) > 1 and math.dist(cleaned[0], cleaned[-1]) <= 1e-7:
        cleaned.pop()
    return cleaned


def triangulate_simple_polygon(points):
    """Ear-clip a small clipped boundary ring into non-overlapping facets."""
    if len(points) < 3:
        return []
    points = list(points)
    changed = True
    while changed and len(points) > 3:
        changed = False
        for index in range(len(points)):
            a, b, c = points[index - 1], points[index], points[(index + 1) % len(points)]
            cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0])
            if abs(cross) <= 1e-9:
                points.pop(index)
                changed = True
                break
    area = sum(points[i][0] * points[(i + 1) % len(points)][1]
               - points[(i + 1) % len(points)][0] * points[i][1] for i in range(len(points))) / 2
    ring = list(range(len(points)))
    if area < 0:
        ring.reverse()
    triangles = []

    def cross(a, b, c):
        return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])

    def in_triangle(point, a, b, c):
        return cross(a, b, point) >= -1e-9 and cross(b, c, point) >= -1e-9 and cross(c, a, point) >= -1e-9

    while len(ring) > 3:
        ear = None
        for position, current in enumerate(ring):
            previous = ring[(position - 1) % len(ring)]
            following = ring[(position + 1) % len(ring)]
            a, b, c = points[previous], points[current], points[following]
            if cross(a, b, c) <= 1e-10:
                continue
            if any(in_triangle(points[index], a, b, c)
                   for index in ring if index not in (previous, current, following)):
                continue
            ear = (position, (previous, current, following))
            break
        if ear is None:
            return []
        triangles.append(ear[1])
        ring.pop(ear[0])
    if len(ring) == 3:
        triangles.append(tuple(ring))
    return triangles


def polygon_area(points):
    return abs(sum(points[i][0] * points[(i + 1) % len(points)][1]
                   - points[(i + 1) % len(points)][0] * points[i][1]
                   for i in range(len(points))) / 2) if len(points) >= 3 else 0.0


def sample_terrain_height(grids, x, y, datum):
    tile_x = max(0, min(5, int(x // 1000)))
    tile_y = max(0, min(5, int(y // 1000)))
    grid = grids[(tile_x, tile_y)]
    c = (x - grid['x0']) / grid['dx']
    r = (y - grid['z0']) / grid['dz']
    i = max(0, min(grid['columns'] - 2, int(math.floor(c))))
    j = max(0, min(grid['rows'] - 2, int(math.floor(r))))
    u, v = c - i, r - j
    k, columns = j * grid['columns'] + i, grid['columns']
    h = grid['heights']
    h_sw, h_se, h_nw, h_ne = h[k], h[k + 1], h[k + columns], h[k + columns + 1]
    # Match the runtime's SW-to-NE cell diagonal, not bilinear interpolation.
    meters = h_sw * (1 - u) + h_se * (u - v) + h_ne * v if u >= v else h_sw * (1 - v) + h_ne * u + h_nw * (v - u)
    return meters - datum


def make_plaza(collection, road, source, world_polygon, grids, building_footprints, vertical_datum):
    p0, p1 = road['points'][0], road['points'][-1]
    dx, dz = p1[0] - p0[0], p1[1] - p0[1]
    length = math.hypot(dx, dz)
    # Set props 8 m north of the mapped living_street centerline, outside its clearance.
    anchor = ((p0[0] + p1[0]) / 2 + dz / length * 8, (p0[1] + p1[1]) / 2 - dx / length * 8)
    anchor_y = sample_terrain_height(grids, anchor[0], anchor[1], vertical_datum)
    batch = MeshBatch()
    # Linear vertex colours based on the grey paving / dark railing visible in
    # the user's photo. Pattern and elevations remain artistic, not surveyed.
    paving_palette = ((0.207, 0.202, 0.196, 1.0), (0.212, 0.207, 0.201, 1.0),
                      (0.216, 0.211, 0.205, 1.0), (0.204, 0.199, 0.193, 1.0))
    paving_light = (0.265, 0.254, 0.235, 1.0)
    plaza_metal = (0.045, 0.048, 0.045, 1.0)

    # Rebuild the mapped square as a continuous, fine-grained paving surface that
    # samples the exact runtime terrain triangles at shared vertices. A narrow
    # exclusion around the existing living_street leaves its runtime road and
    # collision meshes fully authoritative; building interiors are omitted too.
    road_clearance = road.get('width', 5.0) / 2 + road.get('clearance', {}).get('skirtM', 0.6)
    edge_profile = road.get('clearance') or {}
    def road_clearance_at(t, side):
        band = edge_profile.get('bandLeft' if side > 0 else 'bandRight')
        if not band or len(band) < 2:
            return road_clearance - 0.02
        position = max(0.0, min(1.0, t)) * (len(band) - 1)
        index = min(len(band) - 2, int(position))
        fraction = position - index
        return band[index] * (1 - fraction) + band[index + 1] * fraction - 0.02
    # The earlier 4 m panels left large empty wedges. Interior cells use a fine,
    # terrain-conforming grid; partial perimeter cells are clipped to the actual
    # OSM ring to keep its outline smooth rather than stair-stepped.
    min_x, max_x = min(x for x, _ in world_polygon), max(x for x, _ in world_polygon)
    min_z, max_z = min(z for _, z in world_polygon), max(z for _, z in world_polygon)
    cell_size = 1.0
    paving_cells = 0
    partial_cells = 0
    clipped_cells_skipped = 0
    x = math.floor(min_x / cell_size) * cell_size
    while x + cell_size <= max_x:
        z = math.floor(min_z / cell_size) * cell_size
        while z + cell_size <= max_z:
            corners = [(x, z), (x + cell_size, z), (x + cell_size, z + cell_size), (x, z + cell_size)]
            center = (x + cell_size / 2, z + cell_size / 2)
            full_cell = all(inside_polygon(point, world_polygon) for point in (*corners, center))
            clipped = corners if full_cell else clip_polygon_to_rect(
                world_polygon, x, x + cell_size, z, z + cell_size,
            )
            if len(clipped) < 3 or polygon_area(clipped) < 0.01:
                z += cell_size
                continue
            road_points = road['points']
            road_clearance_clipped = False
            if len(road_points) == 2:
                rx, rz = road_points[-1][0] - road_points[0][0], road_points[-1][1] - road_points[0][1]
                t = ((center[0] - road_points[0][0]) * rx + (center[1] - road_points[0][1]) * rz) / (rx * rx + rz * rz or 1.0)
                if 0.0 <= t <= 1.0:
                    signed = rx * (center[1] - road_points[0][1]) - rz * (center[0] - road_points[0][0])
                    side = 1.0 if signed >= 0 else -1.0
                    clipped = clip_polygon_to_road_edge(
                        clipped, road_points, side, road_clearance_at,
                    )
                    # A previously interior square may now be clipped by the
                    # road: emit that clipped shape, never its original corners.
                    full_cell = full_cell and clipped == corners
                    road_clearance_clipped = True
                    if len(clipped) < 3 or polygon_area(clipped) < 0.01:
                        z += cell_size
                        continue
            sample_points = list(clipped)
            if inside_polygon(center, clipped):
                sample_points.append(center)
            if not road_clearance_clipped and any(distance_to_polyline(point, road_points) < road_clearance for point in sample_points):
                z += cell_size
                continue
            if any(inside_polygon(point, footprint) for point in sample_points for footprint in building_footprints):
                z += cell_size
                continue
            if any(x <= px <= x + cell_size and z <= pz <= z + cell_size
                   for footprint in building_footprints for px, pz in footprint):
                z += cell_size
                continue
            # A deterministic, restrained per-slab tint helps the stone read as
            # paving without raster textures or a repeated high-contrast pattern.
            cell_ix, cell_iz = round(x / cell_size), round(z / cell_size)
            tint_hash = (cell_ix * 73856093 + cell_iz * 19349663) & 0xFFFFFFFF
            tint_hash ^= tint_hash >> 13
            tint_hash = (tint_hash * 1274126177) & 0xFFFFFFFF
            # Approximate mottled grey slabs, without adding mesh cost.
            paving_color = paving_palette[(tint_hash >> 29) & 3]
            if full_cell:
                verts = [
                    (wx - anchor[0], wz - anchor[1], sample_terrain_height(grids, wx, wz, vertical_datum) - anchor_y + 0.04)
                    for wx, wz in corners
                ]
                batch.face([verts[0], verts[1], verts[2]], paving_color)
                batch.face([verts[0], verts[2], verts[3]], paving_color)
            else:
                facets = triangulate_simple_polygon(clipped)
                if not facets:
                    clipped_cells_skipped += 1
                    z += cell_size
                    continue
                for facet in facets:
                    verts = [
                        (clipped[index][0] - anchor[0], clipped[index][1] - anchor[1],
                         sample_terrain_height(grids, *clipped[index], vertical_datum) - anchor_y + 0.04)
                        for index in facet
                    ]
                    batch.face(verts, paving_color)
                partial_cells += 1
            paving_cells += 1
            z += cell_size
        x += cell_size

    # A restrained raised forecourt and access ramp echo the local user's photo.
    # The image has no known author, license, date, or camera pose, so this layout
    # is explicitly an approximate, non-georeferenced reconstruction.
    platform_cx, platform_cy = source['platformApproximateCenterWorldXZ']
    half_x, half_y = 6.0, 2.8
    platform_points = [
        (platform_cx - half_x, platform_cy - half_y),
        (platform_cx + half_x, platform_cy - half_y),
        (platform_cx + half_x, platform_cy + half_y),
        (platform_cx - half_x, platform_cy + half_y),
    ]
    platform_heights = [sample_terrain_height(grids, x, z, vertical_datum) + 0.22 for x, z in platform_points]
    local_platform = [(x - anchor[0], z - anchor[1], h - anchor_y) for (x, z), h in zip(platform_points, platform_heights)]
    batch.face([local_platform[0], local_platform[1], local_platform[2]], paving_light)
    batch.face([local_platform[0], local_platform[2], local_platform[3]], paving_palette[1])
    for i, (x, z) in enumerate(platform_points):
        nx, nz = platform_points[(i + 1) % 4]
        base0 = sample_terrain_height(grids, x, z, vertical_datum) - anchor_y + 0.04
        base1 = sample_terrain_height(grids, nx, nz, vertical_datum) - anchor_y + 0.04
        top0, top1 = platform_heights[i] - anchor_y, platform_heights[(i + 1) % 4] - anchor_y
        batch.face([
            (x - anchor[0], z - anchor[1], base0),
            (nx - anchor[0], nz - anchor[1], base1),
            (nx - anchor[0], nz - anchor[1], top1),
            (x - anchor[0], z - anchor[1], top0),
        ], STONE_SHADE)

    # Three broad treads descend from the west end, clear of the road corridor.
    stair_x = platform_cx - half_x - 0.45
    for step in range(3):
        step_y = platform_cy + half_y - (step + 0.5) * 0.62
        ground = sample_terrain_height(grids, stair_x, step_y, vertical_datum) - anchor_y + 0.04
        tread_height = (3 - step) * 0.06
        batch.box(stair_x - anchor[0], step_y - anchor[1], ground + tread_height / 2,
                  0.9, 0.64, tread_height, paving_light)

    # Metal handrails on the two sides of the descending treads and along the
    # forecourt's north edge. These are recognizable low-poly cues, not a survey.
    for rail_x in (stair_x - 0.42, stair_x + 0.42):
        ground0 = sample_terrain_height(grids, rail_x, platform_cy + 0.2, vertical_datum) - anchor_y
        ground1 = sample_terrain_height(grids, rail_x, platform_cy + 1.6, vertical_datum) - anchor_y
        batch.box(rail_x - anchor[0], platform_cy + 0.2 - anchor[1], (ground0 + ground1) / 2 + 0.52,
                  0.08, 2.8, 0.08, plaza_metal)
        for post_y in (platform_cy - 0.8, platform_cy + 0.4, platform_cy + 1.5):
            post_ground = sample_terrain_height(grids, rail_x, post_y, vertical_datum) - anchor_y
            batch.box(rail_x - anchor[0], post_y - anchor[1], post_ground + 0.42,
                      0.08, 0.08, 0.84, plaza_metal)
    rail_z = platform_cy + half_y - 0.2
    rail_ground = sample_terrain_height(grids, platform_cx, rail_z, vertical_datum) - anchor_y
    batch.box(platform_cx - anchor[0], rail_z - anchor[1], rail_ground + 0.78,
              8.0, 0.08, 0.08, plaza_metal)
    for post_x in [platform_cx - 4, platform_cx - 2, platform_cx, platform_cx + 2, platform_cx + 4]:
        base = sample_terrain_height(grids, post_x, rail_z, vertical_datum) - anchor_y
        batch.box(post_x - anchor[0], rail_z - anchor[1], base + 0.42, 0.08, 0.08, 0.84, plaza_metal)

    # Same world-minus-anchor frame as paving: resetAndPlace restores Blender
    # east/north axes. Furniture must not independently mirror local X.
    anchors = source['furnitureAnchorsWorldXZ']
    furniture = [
        (anchors[0], 'bench', 0.0),
        (anchors[1], 'bench', 0.2),
        (anchors[2], 'planter', 0.0),
        (anchors[3], 'lamp', 0.0),
    ]
    for (world_x, world_z), kind, rotation in furniture:
        x = world_x - anchor[0]
        y = world_z - anchor[1]
        ground = sample_terrain_height(grids, world_x, world_z, vertical_datum) - anchor_y + 0.04
        c, s = math.cos(rotation), math.sin(rotation)
        def pos(px, py):
            return (x + px * c - py * s, y + px * s + py * c)
        sx, sy = pos(0, 0)
        if kind == 'bench':
            batch.box(sx, sy, ground + 0.48, 2.0, 0.36, 0.12, WOOD_LIGHT)
            batch.box(sx, sy, ground + 0.82, 2.0, 0.12, 0.62, WOOD)
            for px in (-0.72, 0.72):
                lx, ly = pos(px, 0)
                batch.box(lx, ly, ground + 0.23, 0.12, 0.3, 0.46, plaza_metal)
        elif kind == 'planter':
            batch.box(sx, sy, ground + 0.28, 1.8, 1.5, 0.56, STONE_SHADE, STONE_LIGHT)
            batch.box(sx, sy, ground + 0.62, 1.5, 1.2, 0.18, STONE_LIGHT)
            # Stylized foliage is merged into this single plaza mesh.
            batch.vertical_prism(sx, sy, 0.5, 5, ground + 0.72, ground + 1.35, (0.27, 0.33, 0.20, 1.0))
        else:
            batch.vertical_prism(sx, sy, 0.12, 6, ground, ground + 4.0, plaza_metal)
            batch.box(sx, sy, ground + 3.65, 0.7, 0.7, 0.6, WOOD_LIGHT, STONE_LIGHT)
    obj = batch.create_object('focal:plaza-and-access', collection)
    obj['osm_way_ids'] = '645040295,741760074'
    obj['placement_source'] = 'paving: OSM pedestrian polygon 645040295; anchor: 8 m north of OSM living_street centerline'
    obj['surface_note'] = f'{paving_cells} continuous 1 m terrain-draped OSM paving cells ({partial_cells} clipped boundary cells, {clipped_cells_skipped} skipped slivers); road and collision meshes remain authoritative'
    obj['paving_partial_cells'] = partial_cells
    obj['paving_boundary_slivers_skipped'] = clipped_cells_skipped
    obj['paving_road_edge_overlap_m'] = 0.02
    obj['furniture_note'] = 'world-minus-anchor coordinates; terrain-relative support heights; manual approximate positions, not surveyed'
    obj['photo_reference'] = 'user-provided fotos/Iglesia_plaza.jpg; author, license, date and camera pose unknown; platform is not georeferenced'
    return obj, anchor


def make_dam(collection, raw):
    """Low-poly full replacement for the generic wall, following the mapped crest.

    The Alba dam is an arch dam: the OSM way 168459142 bows ~45 m over its 189 m
    chord, so the straight a-b box used before visibly disagreed with the PNOA
    2023 orthophoto. The concrete body now sweeps that published crest polyline
    (`public/water/water.json` -> dam.crest); levels and width stay sourced.
    """
    dam = raw['dam']
    ax, az = dam['a']
    bx, bz = dam['b']
    anchor = ((ax + bx) / 2, (az + bz) / 2)
    height = dam['crestM'] - dam['baseM']
    half_width = dam['widthM'] / 2
    crest = dam.get('crest') or [dam['a'], dam['b']]
    # Local frame = world minus anchor. The loader restores the anchor and the
    # authored frame survives the glTF round-trip, so no extra yaw is required.
    local = [(x - anchor[0], z - anchor[1]) for x, z in crest]
    batch = MeshBatch()

    def normal_at(index):
        prev = local[max(0, index - 1)]
        nxt = local[min(len(local) - 1, index + 1)]
        dx, dz = nxt[0] - prev[0], nxt[1] - prev[1]
        length = math.hypot(dx, dz) or 1.0
        return (-dz / length, dx / length)

    for i in range(len(local) - 1):
        x0, y0 = local[i]
        x1, y1 = local[i + 1]
        n0 = normal_at(i)
        n1 = normal_at(i + 1)
        # Two sloped faces join one crest node to the next, downstream/upstream.
        a0, b0 = (x0 + n0[0] * half_width, y0 + n0[1] * half_width), (x0 - n0[0] * half_width, y0 - n0[1] * half_width)
        a1, b1 = (x1 + n1[0] * half_width, y1 + n1[1] * half_width), (x1 - n1[0] * half_width, y1 - n1[1] * half_width)
        batch.face([(a0[0], a0[1], 0.0), (a1[0], a1[1], 0.0), (a1[0], a1[1], height), (a0[0], a0[1], height)], STONE_SHADE)
        batch.face([(b0[0], b0[1], 0.0), (b0[0], b0[1], height), (b1[0], b1[1], height), (b1[0], b1[1], 0.0)], STONE_SHADE)
        # A slightly wider low parapet caps the crest; explicitly stylized.
        cap = half_width + 0.4
        ca0, cb0 = (x0 + n0[0] * cap, y0 + n0[1] * cap), (x0 - n0[0] * cap, y0 - n0[1] * cap)
        ca1, cb1 = (x1 + n1[0] * cap, y1 + n1[1] * cap), (x1 - n1[0] * cap, y1 - n1[1] * cap)
        batch.face([(ca0[0], ca0[1], height), (ca1[0], ca1[1], height), (ca1[0], ca1[1], height + 0.45), (ca0[0], ca0[1], height + 0.45)], STONE)
        batch.face([(cb0[0], cb0[1], height), (cb0[0], cb0[1], height + 0.45), (cb1[0], cb1[1], height + 0.45), (cb1[0], cb1[1], height)], STONE)
        batch.face([(ca0[0], ca0[1], height + 0.45), (ca1[0], ca1[1], height + 0.45), (cb1[0], cb1[1], height + 0.45), (cb0[0], cb0[1], height + 0.45)], STONE_LIGHT)
    # Close both ends of the body.
    end_a = normal_at(0)
    end_b = normal_at(len(local) - 1)
    xa, ya = local[0]
    xb, yb = local[-1]
    batch.face([(xa + end_a[0] * half_width, ya + end_a[1] * half_width, 0.0),
                (xa + end_a[0] * half_width, ya + end_a[1] * half_width, height),
                (xa - end_a[0] * half_width, ya - end_a[1] * half_width, height),
                (xa - end_a[0] * half_width, ya - end_a[1] * half_width, 0.0)], STONE)
    batch.face([(xb + end_b[0] * half_width, yb + end_b[1] * half_width, 0.0),
                (xb - end_b[0] * half_width, yb - end_b[1] * half_width, 0.0),
                (xb - end_b[0] * half_width, yb - end_b[1] * half_width, height),
                (xb + end_b[0] * half_width, yb + end_b[1] * half_width, height)], STONE)
    obj = batch.create_object('focal:dam', collection)
    obj['osm_way_id'] = 168459142
    obj['geometry_source'] = 'public/water/water.json dam.crest (OSM way 168459142) + IGN levels'
    obj['architectural_details'] = 'curved crest from the mapped way; parapet stylized, not photo-verified'
    return obj, anchor, 0.0



def reset_scene():
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete(use_global=False)
    for collection in list(bpy.data.collections):
        if collection.name != 'Collection':
            bpy.data.collections.remove(collection)
    scene = bpy.context.scene
    scene.unit_settings.system = 'METRIC'
    return scene


def export_asset(obj, path):
    bpy.ops.object.select_all(action='DESELECT')
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.export_scene.gltf(filepath=str(path), export_format='GLB', use_selection=True, export_apply=True)


def file_hash(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def build():
    source = load_json(SOURCE)
    buildings = load_json(BUILDINGS)['buildings']
    building = next(item for item in buildings if item['id'] == 90614388)
    roads = load_json(ROADS)['roads']
    raw_roads = load_json(ROOT / 'data/roads/raw/osm_highways_window.json')['elements']
    raw_plaza_road = next(item for item in raw_roads if item['id'] == 741760074)
    square = next(item for item in raw_roads if item['id'] == 645040295)
    world_road = next(item for item in roads if item['id'] == '741760074')
    raw_road_origin = raw_plaza_road['geometry'][0]
    projected_road_origin = wgs84_to_world(raw_road_origin['lon'], raw_road_origin['lat'])
    if math.dist(projected_road_origin, world_road['points'][0]) > 0.1:
        raise ValueError('OSM plaza road and WGS84 projection do not align with the versioned EPSG:25830 world')
    world_polygon = [wgs84_to_world(point['lon'], point['lat']) for point in square['geometry']]
    vertical_datum = load_json(ROOT / 'public/terrain/config.json')['verticalDatum']
    terrain_grids = {}
    for tile_x in (3, 4):
        for tile_z in (3, 4):
            tile = load_json(ROOT / f'public/terrain/tiles/tile_{tile_x}_{tile_z}.json')
            terrain_grids[(tile_x, tile_z)] = tile['grid']
    building_footprints = [item['footprint'] for item in buildings]
    water = load_json(ROOT / 'public/water/water.json')
    plaza_road = world_road
    OUT.mkdir(parents=True, exist_ok=True)
    scene = reset_scene()
    church_collection = bpy.data.collections.new('Church Santiago — OSM way 90614388')
    plaza_collection = bpy.data.collections.new('La Plaza — OSM ways 645040295 and 741760074')
    dam_collection = bpy.data.collections.new('Presa de Alba — OSM way 168459142')
    scene.collection.children.link(church_collection)
    scene.collection.children.link(plaza_collection)
    scene.collection.children.link(dam_collection)
    church_obj, church_anchor = make_church(building, church_collection)
    plaza_obj, plaza_anchor = make_plaza(
        plaza_collection, plaza_road, source['sites']['plaza'], world_polygon,
        terrain_grids, building_footprints, vertical_datum,
    )
    dam_obj, dam_anchor, dam_yaw = make_dam(dam_collection, water)
    bpy.ops.wm.save_as_mainfile(filepath=str(BLEND))

    assets = {}
    for site_id, obj, anchor in [('church', church_obj, church_anchor), ('plaza', plaza_obj, plaza_anchor), ('dam', dam_obj, dam_anchor)]:
        glb = OUT / f'{site_id}.glb'
        export_asset(obj, glb)
        triangles = sum(max(0, len(poly.vertices) - 2) for poly in obj.data.polygons)
        assets[site_id] = {
            'glb': f'public/village/focal-sites/{site_id}.glb',
            'blend': 'assets/environment/focal-sites/focal-sites.blend',
            'anchorWorldXZ': [round(anchor[0], 3), round(anchor[1], 3)],
            'bytes': glb.stat().st_size,
            'sha256': file_hash(glb),
            'verticalExtentM': round(float(obj.dimensions.z), 2),
            'triangles': triangles,
            'meshes': 1,
            'osmWayIds': [90614388] if site_id == 'church' else [645040295, 741760074],
            'features': {
                'church': ['cross gable roof', 'extended tower shaft above nave ridge', 'bell tower belfry openings', 'clock face high on shaft', 'octagonal cupola and cross'],
                'plaza': ['continuous draped paving', 'OSM-clipped perimeter', 'variable OSM road-edge profile with 0.02 m visual overlap', 'raised forecourt', 'ramp', 'railings'],
                'dam': ['curved crest', 'low-poly parapet'],
            }[site_id],
            **({'osmWayIds': [168459142], 'yawRad': round(dam_yaw, 8), 'baseM': water['dam']['baseM'], 'crestPoints': len(water['dam']['crest'])} if site_id == 'dam' else {}),
            'reconstruction': 'stylized approximation',
            'rasterTextures': 0,
        }
    manifest = {
        'schemaVersion': 1,
        'reconstruction': 'All landmark geometry is a stylized approximation, not a scan or surveyed architectural record.',
        'attribution': source['attribution'],
        'sources': {
            'church': source['sites']['church'],
            'plaza': source['sites']['plaza'],
            'parking': source['sites']['parking'],
            'dam': source['sites']['dam'],
        },
        'assets': assets,
    }
    (OUT / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf8')
    print(f"Built {len(assets)} focal assets: {sum(a['bytes'] for a in assets.values())} bytes, {sum(a['triangles'] for a in assets.values())} triangles")


if __name__ == '__main__':
    if '--check' not in sys.argv:
        build()
    else:
        with tempfile.TemporaryDirectory(prefix='focal-sites-check-') as temp_dir:
            temp_root = Path(temp_dir)
            OUT = temp_root / 'focal-sites'
            BLEND = temp_root / 'focal-sites.blend'
            build()
            outputs = ['church.glb', 'plaza.glb', 'dam.glb', 'manifest.json']
            failures = []
            for filename in outputs:
                generated = OUT / filename
                committed = ROOT / 'public/village/focal-sites' / filename
                if not committed.exists() or generated.read_bytes() != committed.read_bytes():
                    failures.append(filename)
            if failures:
                print('FALLO: salidas no reproducibles: ' + ', '.join(failures))
                sys.exit(1)
            print('OK: GLB y manifest reproducibles byte a byte; no se modificaron las salidas publicadas')
