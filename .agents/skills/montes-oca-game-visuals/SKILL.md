---
name: montes-oca-game-visuals
description: Improve or review rendered actors, vehicles, materials, lighting, animation, and visual performance in the Montes de Oca Babylon.js game.
---

# Montes de Oca game visuals

Use this skill for runtime art and rendering work in this game. Read the repository `AGENTS.md` and the relevant layer guide first; for geographic geometry use the narrower `montes-oca-3d-cartography` skill as well.

## Project constraints

- The installed runtime is authoritative. Check `package-lock.json` before using a Babylon API; the current locked Babylon core/loaders are 8.56.2, while the online docs may show newer APIs. Start at <https://doc.babylonjs.com/> and confirm the matching API in installed types/source.
- The game has one logical world frame: metres, X east, Z north, Y height above datum 870. Keep physics, terrain sampling, route, water, mission, and minimap values in that frame. Convert only at the rendering boundary when a layer explicitly needs it.
- Keep existing actor interfaces and controls intact. The player model is attached to a single player root; vehicle switching, on-foot mode, mission state, and input must continue through the existing APIs.
- Before visual edits, capture the actual running scene. Useful project harnesses include `scripts/vehicle/capture_vehicle.mjs`, `scripts/vehicle/drive_catalog.mjs`, `scripts/milestone/drive_milestone.mjs`, and the environment capture scripts. Pass a temporary output directory when existing evidence must be preserved. Compare the same camera and scene state.

## Assets and actors

- Prefer a suitable, licensed GLB/glTF for complex humanoids and vehicles. Verify source author, per-asset license, hierarchy, skin and animation tracks, forward/up axes, measured dimensions, textures/color space, file size, and runtime triangle/draw cost before integration. Record those facts next to the asset. Never infer license from a category page or model name.
- Assets served by Vite live under `public/` and should be resolved with `src/public-url.ts`. Register the loader with `import '@babylonjs/loaders/glTF'`; use `SceneLoader.LoadAssetContainerAsync` when the actor needs to validate content, attach it under the established root, and dispose its resources deliberately.
- An unavailable or invalid asset must be reported clearly and leave a visible working fallback. Do not silently claim a placeholder is finished art. Keep source files and conversion settings when they materially support rebuilding the shipped GLB.
- Map idle and locomotion clips from actual movement state, avoid root-motion drift when gameplay owns position, transition intentionally, and dispose animation groups/container with the actor. Do not claim a walk cycle exists when the supplied GLB only has idle and run.
- No separate NPC population or AI system has been found in the game baseline; confirm current source before planning NPC-specific work.

## Lighting and cost

- One atmosphere owner creates the world lights and the shadow generator in `src/environment/atmosphere.ts`. Its shadow list, camera-following frustum, and 1024 map were deliberately bounded; change them only to fix a scene-visible issue and compare the same view.
- `createAtmosphere` loads the Poly Haven farmland HDR panorama as a prefiltered 128 px `HDRCubeTexture`, assigns it to `scene.environmentTexture`, and uses Babylon's PBR default skybox without replacing the global environment. Check the live setup before changing ownership, color space, skybox material, or memory cost.
- `src/environment/vegetation.ts` already uses thin instances and distance buckets. Preserve its explicit thin-instance module registration and test visible bounds, picking, shadows, and collisions when changing those paths.
- Measure active meshes, draw calls, triangles, asset bytes, and texture memory when the change affects runtime cost. Chrome headless/SwiftShader frame time is not target-GPU performance.
- Avoid adding a postprocess pipeline unless a repeatable comparison shows a worthwhile improvement within the measured budget.

## Verify the real game

- Run the narrow domain validator, `npm run typecheck`, and `npm run build`; use `npm test` when changes span domains or the repository gate requires it.
- For rendered changes, use the repository's Chrome/CDP capture harness if the optional `agent-browser` CLI is unavailable. Exercise the actual interaction path as well as screenshots, check console errors and missing assets, and inspect the output images directly.
- Report what was observed, what remains approximate, and whether performance is measured on the target GPU or only by a headless harness.

## Current asset note

The player can use `public/characters/field-player.glb`, built from the retained Kenney Animated Characters 3 source pack under `assets/characters/kenney-animated-characters-3/` with `scripts/player/build_kenney_character.py`. Its license and source are recorded in `asset.json`; the GLB contains Idle, retargeted Walk, and Run groups. Refresh these paths and properties from the live checkout before relying on this note.

The default 4x4 and patrol use `public/vehicles/four-door-utility.glb`. It is a generic four-door SUV, not a Mitsubishi or Nissan model; `public/vehicles/ATTRIBUTION.md` preserves the provider's CC0 and AI-origin claims without presenting them as independently verified. The runtime validates four named wheel pivots and drawable meshes, drives those pivots, and retains a visible procedural fallback. The NullEngine model validator does not prove the asynchronous GLB loaded: verify the actual browser scene and wheel pose with the vehicle capture harness before claiming the asset works. Refresh the live asset, loader, manifest, and triangle/draw measurements before relying on this note.
