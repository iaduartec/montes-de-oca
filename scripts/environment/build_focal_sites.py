#!/usr/bin/env python3
"""Build small, texture-free Blender assets for the church and plaza."""
import hashlib
import json
import math
from pathlib import Path

import bpy

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / 'assets/environment/focal-sites/sites.json'
BUILDINGS = ROOT / 'public/village/buildings.json'
ROADS = ROOT / 'public/roads/roads.json'
BLEND = ROOT / 'assets/environment/focal-sites/focal-sites.blend'
OUT = ROOT / 'public/village/focal-sites'

STONE = (0.56, 0.51, 0.41, 1.0)
STONE_LIGHT = (0.67, 0.61, 0.49, 1.0)
STONE_SHADE = (0.43, 0.39, 0.32, 1.0)
ROOF = (0.52, 0.22, 0.15, 1.0)
ROOF_LIGHT = (0.64, 0.30, 0.20, 1.0)
DARK = (0.12, 0.12, 0.11, 1.0)
WOOD = (0.32, 0.23, 0.15, 1.0)
WOOD_LIGHT = (0.44, 0.33, 0.22, 1.0)
METAL = (0.20, 0.21, 0.19, 1.0)


class MeshBatch:
    def __init__(self):
        self.vertices = []
        self.faces = []
        self.colors = []

    def face(self, points, color):
        first = len(self.vertices)
        self.vertices.extend(points)
        self.faces.append(tuple(range(first, first + len(points))))
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
        self.face(right, color)
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


def make_church(building, collection):
    footprint = building['footprint']
    anchor = polygon_centroid(footprint)
    points = localize(footprint, anchor)
    xmin = min(p[0] for p in points)
    xmax = max(p[0] for p in points)
    ymin = min(p[1] for p in points)
    ymax = max(p[1] for p in points)
    batch = MeshBatch()
    # OSM footprint and heuristic wall height retain the measured game scale.
    add_polygon_walls(batch, points, 5.8)
    add_gable_roof(batch, xmin + 1, xmax - 1, ymin + 1, ymax - 1, 6.0, 8.7, ROOF)
    # Stone cornice bands and a few broad courses suggest local masonry without textures.
    for h, inset in [(0.38, 0.05), (5.5, 0.0)]:
        for i, (x0, y0) in enumerate(points):
            x1, y1 = points[(i + 1) % len(points)]
            batch.face([(x0, y0, h), (x1, y1, h), (x1, y1, h + 0.14), (x0, y0, h + 0.14)], STONE_LIGHT if i % 2 else STONE)

    # Bell tower at the west end, capped below the OSM type-derived 12.8 m estimate.
    tx = xmin + 5.2
    tw = 6.3
    batch.box(tx, 0, 4.15, tw, tw, 8.3, STONE, STONE_LIGHT)
    # The belfry reads as open bays; their dark backing is vertex color in the same mesh.
    for dx in (-1.65, 1.65):
        batch.box(tx + dx, -3.19, 9.25, 1.2, 0.035, 1.65, DARK)
        batch.box(tx + dx, 3.19, 9.25, 1.2, 0.035, 1.65, DARK)
    for dx in (-2.65, 2.65):
        for dy in (-2.65, 2.65):
            batch.box(tx + dx, dy, 8.65, 0.22, 0.22, 2.6, STONE_LIGHT)
    batch.vertical_prism(tx, 0, 3.5, 8, 10.45, 11.6, STONE_LIGHT)
    # Low octagonal dome and cross stay within the approximate overall height.
    lower = []
    upper = []
    for i in range(8):
        a = math.tau * i / 8 + math.pi / 8
        lower.append((tx + math.cos(a) * 3.45, math.sin(a) * 3.45, 11.58))
        upper.append((tx + math.cos(a) * 0.75, math.sin(a) * 0.75, 12.55))
    for i in range(8):
        j = (i + 1) % 8
        batch.face([lower[i], lower[j], upper[j], upper[i]], ROOF if i % 2 else ROOF_LIGHT)
    batch.face(upper, ROOF)
    batch.box(tx, 0, 12.69, 0.16, 0.16, 0.2, STONE_LIGHT)
    batch.box(tx, 0, 12.54, 0.54, 0.12, 0.1, STONE_LIGHT)

    # Main entrance and clock on the south face; simple graphic forms, not a measured scan.
    door = [(tx - 0.95, -3.23, 0.0), (tx + 0.95, -3.23, 0.0), (tx + 0.95, -3.23, 2.45), (tx - 0.95, -3.23, 2.45)]
    batch.face(door, DARK)
    batch.face([(tx - 1.12, -3.26, 0.12), (tx - 1.0, -3.26, 0.12), (tx - 1.0, -3.26, 2.55), (tx - 1.12, -3.26, 2.55)], STONE_LIGHT)
    batch.face([(tx + 1.0, -3.26, 0.12), (tx + 1.12, -3.26, 0.12), (tx + 1.12, -3.26, 2.55), (tx + 1.0, -3.26, 2.55)], STONE_LIGHT)
    batch.cylinder_y(tx, -3.26, 7.65, 0.68, 0.04, 12, STONE_LIGHT)
    batch.box(tx, -3.30, 7.65, 0.06, 0.035, 0.92, DARK)
    batch.box(tx, -3.31, 7.65, 0.62, 0.035, 0.06, DARK)

    # Narrow side windows provide rhythm visible from the plaza; remain merged in Color.
    for x in (xmin + 12, xmin + 21, xmin + 29):
        if x < xmax - 2:
            batch.box(x, ymin - 0.035, 3.5, 0.62, 0.04, 1.5, DARK)
            batch.box(x + 0.02, ymin - 0.06, 3.48, 0.08, 0.05, 1.7, STONE_LIGHT)
    obj = batch.create_object('focal:church', collection)
    obj['osm_way_id'] = 90614388
    obj['height_m'] = 12.8
    obj['height_source'] = 'type-derived from four floors; not LiDAR'
    obj['footprint_source'] = 'public/village/buildings.json'
    obj['photo_reference'] = 'Gerd Eichmann, CC BY-SA 4.0'
    return obj, anchor


def make_plaza(collection, road, source):
    p0, p1 = road['points'][0], road['points'][-1]
    dx, dz = p1[0] - p0[0], p1[1] - p0[1]
    length = math.hypot(dx, dz)
    # Set props 8 m north of the mapped living_street centerline, outside its clearance.
    anchor = ((p0[0] + p1[0]) / 2 + dz / length * 8, (p0[1] + p1[1]) / 2 - dx / length * 8)
    batch = MeshBatch()
    # Site data stores audited world-space anchors. GLB axis conversion reverses
    # Blender local X for Babylon X, while Blender local Y maps forward to world Z.
    anchors = source['furnitureAnchorsWorldXZ']
    furniture = [
        (anchors[0], 'bench', 0.0),
        (anchors[1], 'bench', 0.2),
        (anchors[2], 'planter', 0.0),
        (anchors[3], 'lamp', 0.0),
    ]
    for (world_x, world_z), kind, rotation in furniture:
        x = anchor[0] - world_x
        y = world_z - anchor[1]
        c, s = math.cos(rotation), math.sin(rotation)
        def pos(px, py):
            return (x + px * c - py * s, y + px * s + py * c)
        sx, sy = pos(0, 0)
        if kind == 'bench':
            batch.box(sx, sy, 0.48, 2.0, 0.36, 0.12, WOOD_LIGHT)
            batch.box(sx, sy, 0.82, 2.0, 0.12, 0.62, WOOD)
            for px in (-0.72, 0.72):
                lx, ly = pos(px, 0)
                batch.box(lx, ly, 0.23, 0.12, 0.3, 0.46, METAL)
        elif kind == 'planter':
            batch.box(sx, sy, 0.28, 1.8, 1.5, 0.56, STONE_SHADE, STONE_LIGHT)
            batch.box(sx, sy, 0.62, 1.5, 1.2, 0.18, STONE_LIGHT)
            # Stylized foliage is merged into this single plaza mesh.
            batch.vertical_prism(sx, sy, 0.5, 5, 0.72, 1.35, (0.27, 0.33, 0.20, 1.0))
        else:
            batch.vertical_prism(sx, sy, 0.12, 6, 0, 4.0, METAL)
            batch.box(sx, sy, 3.65, 0.7, 0.7, 0.6, WOOD_LIGHT, STONE_LIGHT)
    obj = batch.create_object('focal:plaza-props', collection)
    obj['osm_way_ids'] = '645040295,741760074'
    obj['placement_source'] = '8 m north of local OSM living_street centerline'
    obj['surface_note'] = 'existing road and collision meshes remain authoritative'
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


def main():
    source = load_json(SOURCE)
    buildings = load_json(BUILDINGS)['buildings']
    building = next(item for item in buildings if item['id'] == 90614388)
    roads = load_json(ROADS)['roads']
    water = load_json(ROOT / 'public/water/water.json')
    plaza_road = next(item for item in roads if item['id'] == '741760074')
    OUT.mkdir(parents=True, exist_ok=True)
    scene = reset_scene()
    church_collection = bpy.data.collections.new('Church Santiago — OSM way 90614388')
    plaza_collection = bpy.data.collections.new('La Plaza — OSM ways 645040295 and 741760074')
    dam_collection = bpy.data.collections.new('Presa de Alba — OSM way 168459142')
    scene.collection.children.link(church_collection)
    scene.collection.children.link(plaza_collection)
    scene.collection.children.link(dam_collection)
    church_obj, church_anchor = make_church(building, church_collection)
    plaza_obj, plaza_anchor = make_plaza(plaza_collection, plaza_road, source['sites']['plaza'])
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
            'triangles': triangles,
            'meshes': 1,
            'osmWayIds': [90614388] if site_id == 'church' else [645040295, 741760074],
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
    main()
