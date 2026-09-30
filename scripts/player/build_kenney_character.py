"""Build the checked-in Kenney CC0 humanoid GLB from its source FBX pack.

Run with Blender 4.0.2:
  blender --background --factory-startup --python scripts/player/build_kenney_character.py
"""

from pathlib import Path
import bpy
from mathutils import Quaternion, Vector


ROOT = Path(__file__).resolve().parents[2]
ASSET_DIR = ROOT / "assets" / "characters" / "kenney-animated-characters-3"
SOURCE = ASSET_DIR / "source"
OUTPUT = ROOT / "public" / "characters" / "field-player.glb"
MODEL = SOURCE / "Model" / "characterMedium.fbx"
SKIN = SOURCE / "Skins" / "humanMaleA.png"
WALK_SOURCE = ROOT / "assets" / "characters" / "quaternius-universal-animation-library" / "UAL1_Standard.glb"
ANIMATION_FILES = (
    ("Idle", SOURCE / "Animations" / "idle.fbx"),
    ("Run", SOURCE / "Animations" / "run.fbx"),
)
ARM_POSE_TARGETS = {
    # Kenney's neutral rig is exported in a straight T-pose. Lower upper arms
    # toward the hips and give the elbows a slight bend while retaining the
    # authored motion in both clips.
    "LeftArm": Vector((0.72, 0.0, -0.69)),
    "RightArm": Vector((-0.72, 0.0, -0.69)),
    "LeftForeArm": Vector((0.92, 0.0, -0.39)),
    "RightForeArm": Vector((-0.92, 0.0, -0.39)),
}
WALK_BONE_MAP = {
    "Hips": "pelvis",
    "Spine": "spine_01",
    "Chest": "spine_02",
    "UpperChest": "spine_03",
    "Neck": "neck_01",
    "Head": "Head",
    "LeftShoulder": "clavicle_l",
    "LeftArm": "upperarm_l",
    "LeftForeArm": "lowerarm_l",
    "LeftHand": "hand_l",
    "RightShoulder": "clavicle_r",
    "RightArm": "upperarm_r",
    "RightForeArm": "lowerarm_r",
    "RightHand": "hand_r",
    "LeftUpLeg": "thigh_l",
    "LeftLeg": "calf_l",
    "LeftFoot": "foot_l",
    "LeftToes": "ball_l",
    "RightUpLeg": "thigh_r",
    "RightLeg": "calf_r",
    "RightFoot": "foot_r",
    "RightToes": "ball_r",
}


def import_fbx(filepath: Path) -> None:
    bpy.ops.import_scene.fbx(filepath=str(filepath), use_anim=True)


def lower_t_pose_arms(action: bpy.types.Action, armature: bpy.types.Object) -> None:
    """Offset arm tracks from the pack's straight T-pose to a relaxed stance."""
    for bone_name, target_direction in ARM_POSE_TARGETS.items():
        bone = armature.data.bones.get(bone_name)
        if bone is None:
            raise RuntimeError(f"Missing rig bone required for the field pose: {bone_name}")
        direction = (bone.tail_local - bone.head_local).normalized()
        target = target_direction.normalized()
        armature_delta = direction.rotation_difference(target)
        rest_rotation = bone.matrix_local.to_3x3().to_quaternion()
        local_offset = rest_rotation.inverted() @ armature_delta @ rest_rotation

        path = f'pose.bones["{bone_name}"].rotation_quaternion'
        curves = [curve for curve in action.fcurves if curve.data_path == path]
        if len(curves) != 4:
            raise RuntimeError(f"Expected four quaternion curves for {bone_name}, got {len(curves)}")
        frame_sets = [{point.co.x for point in curve.keyframe_points} for curve in curves]
        if any(frames != frame_sets[0] for frames in frame_sets[1:]):
            raise RuntimeError(f"Misaligned quaternion keys for {bone_name}")
        for frame in sorted(frame_sets[0]):
            current = Quaternion(tuple(curve.evaluate(frame) for curve in curves))
            adjusted = local_offset @ current
            for curve, value in zip(curves, adjusted):
                point = next(point for point in curve.keyframe_points if abs(point.co.x - frame) < 1e-5)
                point.co.y = value
                point.handle_left.y = value
                point.handle_right.y = value


def retarget_walk(armature: bpy.types.Object, tracks: list[bpy.types.NlaTrack]) -> bpy.types.NlaTrack:
    """Bake Quaternius's authored CC0 walk onto Kenney's humanoid rig."""
    if not WALK_SOURCE.is_file():
        raise FileNotFoundError(f"Missing licensed walk source: {WALK_SOURCE}")

    before_objects = set(bpy.data.objects)
    before_actions = set(bpy.data.actions)
    bpy.ops.import_scene.gltf(filepath=str(WALK_SOURCE))
    imported_objects = [obj for obj in bpy.data.objects if obj not in before_objects]
    source_rigs = [obj for obj in imported_objects if obj.type == "ARMATURE"]
    if len(source_rigs) != 1:
        raise RuntimeError(f"Expected one source armature, got {len(source_rigs)}")
    source_rig = source_rigs[0]
    source_action = bpy.data.actions.get("Walk_Loop_Armature")
    if source_action is None:
        raise RuntimeError("Quaternius GLB is missing Walk_Loop_Armature")
    missing = [
        (target, source)
        for target, source in WALK_BONE_MAP.items()
        if target not in armature.data.bones or source not in source_rig.data.bones
    ]
    if missing:
        raise RuntimeError(f"Walk retarget bone map does not match rigs: {missing}")

    source_rig.animation_data_create()
    source_rig.animation_data.action = source_action
    constraints = []
    for target_name, source_name in WALK_BONE_MAP.items():
        constraint = armature.pose.bones[target_name].constraints.new("COPY_ROTATION")
        constraint.name = "Quaternius Walk Retarget"
        constraint.target = source_rig
        constraint.subtarget = source_name
        constraint.target_space = "WORLD"
        constraint.owner_space = "WORLD"
        constraint.mix_mode = "REPLACE"
        constraints.append(constraint)

    # Existing idle/run tracks must not be evaluated on top of the retarget.
    for track in tracks:
        track.mute = True
    start, end = (int(frame) for frame in source_action.frame_range)
    scene = bpy.context.scene
    scene.frame_set(start)
    bpy.ops.object.select_all(action="DESELECT")
    armature.select_set(True)
    bpy.context.view_layer.objects.active = armature
    bpy.ops.nla.bake(
        frame_start=start,
        frame_end=end,
        only_selected=False,
        visual_keying=True,
        clear_constraints=True,
        use_current_action=False,
        bake_types={"POSE"},
    )
    baked_action = armature.animation_data.action
    if baked_action is None or baked_action in before_actions:
        raise RuntimeError("Blender did not produce a baked walk action")
    baked_action.name = "Walk"
    baked_action.id_root = "OBJECT"
    track = armature.animation_data.nla_tracks.new()
    track.name = "Walk"
    strip = track.strips.new("Walk", 1, baked_action)
    strip.frame_start = start
    strip.frame_end = end
    strip.action_frame_start = start
    strip.action_frame_end = end
    strip.blend_type = "REPLACE"
    armature.animation_data.action = None
    for existing in tracks:
        existing.mute = False

    for obj in imported_objects:
        bpy.data.objects.remove(obj, do_unlink=True)
    for action in list(bpy.data.actions):
        if action not in before_actions and action is not baked_action:
            bpy.data.actions.remove(action)
    return track


def main() -> None:
    if not MODEL.is_file() or not SKIN.is_file():
        raise FileNotFoundError("Extract the documented Kenney source pack before building the player GLB")

    bpy.ops.wm.read_factory_settings(use_empty=True)
    import_fbx(MODEL)
    armature = next(obj for obj in bpy.context.scene.objects if obj.type == "ARMATURE")
    mesh = next(obj for obj in bpy.context.scene.objects if obj.type == "MESH")

    # The source FBX is in centimetre-derived units: scale its measured 3.765 m
    # Z-height to 1.8 m while retaining its authored proportions and rig.
    asset_root = bpy.data.objects.new("field-player-root", None)
    bpy.context.scene.collection.objects.link(asset_root)
    armature.parent = asset_root
    mesh.parent = armature
    asset_root.scale = (1.8 / 3.765, 1.8 / 3.765, 1.8 / 3.765)

    material = bpy.data.materials.get("skin") or bpy.data.materials.new("field-player-skin")
    material.use_nodes = True
    nodes = material.node_tree.nodes
    links = material.node_tree.links
    shader = next((node for node in nodes if node.type == "BSDF_PRINCIPLED"), None)
    if shader is None:
        shader = nodes.new("ShaderNodeBsdfPrincipled")
    image = bpy.data.images.load(str(SKIN), check_existing=True)
    texture = nodes.new("ShaderNodeTexImage")
    texture.image = image
    links.new(texture.outputs["Color"], shader.inputs["Base Color"])
    mesh.data.materials.clear()
    mesh.data.materials.append(material)

    armature.animation_data_clear()
    tracks = []
    for name, filepath in ANIMATION_FILES:
        if not filepath.is_file():
            raise FileNotFoundError(f"Missing {name} animation: {filepath}")
        before = set(bpy.data.objects)
        before_actions = set(bpy.data.actions)
        import_fbx(filepath)
        imported_rigs = [obj for obj in bpy.data.objects if obj.type == "ARMATURE" and obj is not armature and obj not in before]
        if len(imported_rigs) != 1:
            raise RuntimeError(f"Expected one imported armature for {name}, got {len(imported_rigs)}")
        source_rig = imported_rigs[0]
        actions = [
            action
            for action in bpy.data.actions
            if action not in before_actions and action.name.endswith(f"|{name}")
        ]
        if len(actions) != 1:
            raise RuntimeError(f"Expected one {name} action in {filepath}, got {[action.name for action in actions]}")
        source_action = actions[0]
        lower_t_pose_arms(source_action, armature)
        source_action.name = name
        source_action.id_root = "OBJECT"
        armature.animation_data_create()
        track = armature.animation_data.nla_tracks.new()
        track.name = name
        strip = track.strips.new(name, 1, source_action)
        strip.frame_start = source_action.frame_range[0]
        strip.frame_end = source_action.frame_range[1]
        strip.action_frame_start = source_action.frame_range[0]
        strip.action_frame_end = source_action.frame_range[1]
        strip.blend_type = "REPLACE"
        tracks.append(track)
        bpy.data.objects.remove(source_rig, do_unlink=True)

    keep_actions = {strip.action for track in tracks for strip in track.strips}
    for action in list(bpy.data.actions):
        if action not in keep_actions:
            bpy.data.actions.remove(action)

    tracks.append(retarget_walk(armature, tracks))

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.object.select_all(action="DESELECT")
    for obj in (asset_root, armature, mesh):
        obj.select_set(True)
    bpy.context.view_layer.objects.active = armature
    bpy.ops.export_scene.gltf(
        filepath=str(OUTPUT),
        export_format="GLB",
        use_selection=True,
        export_animations=True,
        export_nla_strips=True,
        export_skins=True,
        export_apply=True,
        export_image_format="AUTO",
        export_yup=True,
    )
    print(f"Built {OUTPUT} ({OUTPUT.stat().st_size} bytes); animations={[track.name for track in tracks]}")


if __name__ == "__main__":
    main()
