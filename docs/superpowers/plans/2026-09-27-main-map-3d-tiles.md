# Mapa principal con 3D Tiles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Delegate bounded data-builder, runtime-renderer and validator reviews to the OpenCode models requested by the user; the orchestrator owns shared interfaces, scene migration and integration.

**Goal:** Integrate a locally generated, streamed 3D Tiles terrain into the playable Villafranca map while preserving the current simulation and geographic data.

**Architecture:** Keep EPSG:25830 and all physics queries in the current logical frame. Convert render positions and directions through one tested boundary, migrate all visible layers to a single Babylon RH scene, and load the local tileset through `TilesRenderer`. Keep the current MDT terrain mesh as a recoverable visual fallback until the new scene, map layers and mission pass browser checks.

**Tech Stack:** Babylon.js 8.56.2, `3d-tiles-renderer` 0.5.3, TypeScript, Python terrain builders, existing Node/browser validation harnesses and Vite.

**Spec:** `docs/superpowers/specs/2026-09-27-babylon-3d-tiles-main-map-design.md`

## Global Constraints

- The reference frame remains EPSG:25830 with origin `E=471500, N=4689000`; X grows east, logical Z grows north, and Y is height minus 870 m.
- `heightAt`, `normalAt`, vehicle/player simulation, routes, water rules and minimap remain in the logical frame.
- Terrain 3D Tiles are visual only; the existing 5 m heightfield remains authoritative for physics, placement and collisions.
- Use existing MDT05, PNOA and OSM inputs; MDS02 remains a later data improvement until acquired and validated for sheet 0201-4.
- Keep PNOA images external to GLB/GLTF and preserve IGN/CNIG CC BY 4.0 and OSM ODbL 1.0 attribution.
- Do not change mission, controls, physics, OSM data or building geometry to imply unsupported precision.
- Keep a visual terrain fallback available until the 3D Tiles map passes the acceptance checks; never render coincident terrain surfaces together.
- Do not claim target-GPU performance from SwiftShader captures.

## Review Focus

- **North/south reflection, yaw or normals:** cardinal conversion, round trips and a sloped test patch must retain heading and outward-facing lit surfaces (Task 1).
- **Height disagreement or tile seams:** tile samples must match the heightfield at tile edges/corners and points inside tiles within 0.01 m (Task 2).
- **Missing/corrupt tile requests:** the fallback remains visible, physics queries continue, and the failure reports URL plus tile id without uncaught errors (Task 3).
- **Coordinate drift across existing layers:** roads, water, houses, trees, landmarks and actors must match their logical anchors after conversion (Tasks 4–5).
- **Partial loading or regression in the playable loop:** mission completion, minimap orientation and browser console/network status must pass before the new map becomes the default (Task 6).

## Files and ownership

- `src/render-coordinates.ts` owns pure logical↔Babylon RH coordinate, direction and yaw conversion. It must not import terrain or alter source data.
- `scripts/terrain/build_3d_tiles.py` and `scripts/terrain/validate_3d_tiles.py` build and validate a reproducible six-by-six set of 1 km contents from the existing 36 MDT05 tiles and PNOA atlas; generated output and provenance live under `public/terrain/3d-tiles/`.
- `src/terrain-3d-tiles.ts` owns `TilesRenderer`, loading/error counters and disposal. `src/terrain.ts` continues to own existing heightfield sampling and fallback terrain meshes.
- `src/main.ts` owns the `?renderFrame=rh` migration switch, camera/render-loop integration and the final default activation gate. The ordinary game launch stays in its current frame until every rendered layer has migrated.
- `src/road-visuals.ts`, `src/environment/{village,vegetation,water,village-landmarks}.ts`, `src/vehicle/*.ts`, `src/player/index.ts` and `src/gameplay/objective.ts` migrate visible geometry/actors through the shared conversion boundary; their simulation inputs stay logical.
- `scripts/terrain/test_render_coordinates.mjs`, `scripts/terrain/test_3d_tiles_builder.py`, `scripts/terrain/validate_3d_tiles.py`, existing domain validators and `scripts/milestone/drive_milestone.mjs` provide focused proof.
- `scripts/terrain/capture_3d_tiles_map.mjs` saves at most seven named images for aerial overview, village, road, water/reservoir, vehicle pursuit, on-foot controls and mission completion under `output/3d-tiles-map/`.
- Delegate only bounded tasks: Muse Spark 1.3 Contributor for the Python builder, MiMo-V2.6-Flash for isolated renderer/runtime error handling, DeepSeek V4.1 Flash for validator and parity review, and Space Bunny Free for an optional read-only final review. Confirm model availability before dispatch; the orchestrator owns shared interfaces, Babylon scene and actor migration. Do not let workers edit `src/main.ts` concurrently.

### Task 1: Pin and implement logical-to-render conversion

**Files:** Create `src/render-coordinates.ts` and `scripts/terrain/test_render_coordinates.mjs`; modify `package.json` only to register the focused check if needed.

**Interfaces:**
- `logicalToRender(point: LogicalPoint): RenderPoint` and `renderToLogical(point: RenderPoint): LogicalPoint` map `(x,y,z)` to `(x,y,-z)` and back.
- `logicalYawToRender(yawRad: number): number` and `renderYawToLogical(yawRad: number): number` preserve the forward direction under the Z reflection.
- Direction/normal helpers reflect Z and normalize only when the caller requests normalized output; physics data is never passed through them.

- [ ] **Step 1: Add failing checks** `roundTripsLogicalPosition`, `northMapsToNegativeRenderZ`, `eastAndUpRemainUnchanged`, `yawKeepsForwardVector`, and `rejectsNonFiniteInput` to `scripts/terrain/test_render_coordinates.mjs`.
- [ ] **Step 2: Run** `node scripts/terrain/test_render_coordinates.mjs`. Expected: FAIL because the conversion module or exports are missing.
- [ ] **Step 3: Implement the typed conversion functions** in `src/render-coordinates.ts`; keep the implementation independent from Babylon classes so the pure contract is executable in Node.
- [ ] **Step 4: Run** `node scripts/terrain/test_render_coordinates.mjs` and `npm run build`. Expected: all conversion assertions pass and TypeScript/Vite build succeeds.
- [ ] **Step 5: Commit** as `feat(cartography): define render coordinate boundary`.

### Task 2: Build deterministic local 3D Tiles contents

**Files:** Create `scripts/terrain/build_3d_tiles.py`, `scripts/terrain/test_3d_tiles_builder.py`, `scripts/terrain/validate_3d_tiles.py`, and generated `public/terrain/3d-tiles/`; update `package.json` focused scripts and `public/terrain/ATTRIBUTION.md`.

**Interfaces:**
- Normal builder mode writes 36 1 km GLTF contents, external image references to the existing PNOA atlas, tileset hierarchy/index and a manifest with source/output hashes, extents, sample spacing, generation parameters and attribution.
- `build_3d_tiles.py --check` derives to temporary output and compares deterministically without rewriting public files or accessing network resources.
- Validator exits nonzero for missing tiles, invalid bounds/CRS/origin/datum, wrong PNOA path, invalid hierarchy, hash drift or absent attribution.

- [ ] **Step 1: Add fixtures/checks** `all_36_tiles_match_config_extent`, `neighbor_edges_share_identical_height_samples`, `mesh_heights_use_config_vertical_datum`, `orthophoto_reference_is_external`, and `check_mode_is_deterministic`.
- [ ] **Step 2: Run** `python3 scripts/terrain/test_3d_tiles_builder.py`. Expected: FAIL because the builder contract is absent.
- [ ] **Step 3: Implement the builder** using all existing `public/terrain/tiles/tile_*.json`; create matching tile bounds and adjacent edge samples, with measured LOD/geometric error rather than placeholder values. Reuse the PNOA atlas URI; do not copy pixels into tile GLTFs.
- [ ] **Step 4: Run** `python3 scripts/terrain/test_3d_tiles_builder.py`, `python3 scripts/terrain/build_3d_tiles.py --check`, and `python3 scripts/terrain/validate_3d_tiles.py`. Expected: all 36 outputs validate and repeated derivation has identical hashes.
- [ ] **Step 5: Register** `test:3d-tiles-data` and include it in `npm test`; record IGN/CNIG and OSM attribution in the runtime attribution surface and asset manifest.
- [ ] **Step 6: Commit** as `feat(terrain): build local 3d tiles map`.

### Task 3: Add a contained Babylon TilesRenderer runtime

**Files:** Create `src/terrain-3d-tiles.ts` and `scripts/terrain/test_3d_tiles_runtime.mjs`; do not initialize the adapter from the ordinary game scene yet.

**Interfaces:**
- `createTerrain3DTiles(scene, camera, options)` returns `{ update(), dispose(), stats() }`; `stats()` exposes active tiles, visible triangles and loaded bytes when available.
- Renderer errors include content URL and tile id; creation/load failure returns a usable error state and never removes heightfield samplers or fallback meshes.
- Tiles are updated once per rendered frame; no second scene or independent camera is created.
- The adapter is only created when its supplied scene already has `useRightHandedSystem === true`; `main.ts` integration waits for Task 5.

- [ ] **Step 1: Add runtime checks** `updates_renderer_each_frame`, `reports_failed_tile_with_url_and_id`, `dispose_removes_observer`, and `heightfield_remains_usable_after_load_error`.
- [ ] **Step 2: Run** `node scripts/terrain/test_3d_tiles_runtime.mjs`. Expected: FAIL before the runtime adapter exists.
- [ ] **Step 3: Implement the adapter** with Babylon's required RH scene, the supplied camera and explicit observer cleanup. Reject an LH scene with a descriptive error.
- [ ] **Step 4: Run** `node scripts/terrain/test_3d_tiles_runtime.mjs` and `npm run build`; test local tile loading in the existing RH POC harness, with no external tile/image URLs.
- [ ] **Step 5: Commit** as `feat(terrain): add babylon 3d tiles runtime`.

### Task 4: Migrate static map layers at the render boundary

**Files:** Modify `src/terrain.ts`, `src/road-visuals.ts`, `src/environment/village.ts`, `src/environment/vegetation.ts`, `src/environment/water.ts`, and `src/environment/village-landmarks.ts`; add or extend affected terrain, roads, village, vegetation and water validators.

**Interfaces:**
- Render geometry receives converted positions/directions only at mesh creation/update; generated files, logical anchors, `heightAt`, `normalAt` and geographic projection remain unchanged.
- Each layer uses the ordinary Babylon frame by default and applies the shared conversion only when main starts with `?renderFrame=rh`; the switch is fixed before layer construction and is never toggled mid-scene.
- Each layer exposes the same public logical query and update interface it exposes before this migration.

- [ ] **Step 1: Add parity assertions** for known east/north anchors, landmark base heights, water sample locations, road clearance and one instance from each vegetation tier; assert expected render Z is the negated logical Z.
- [ ] **Step 2: Run the affected validators** and confirm the new render-frame assertions fail while existing logical-data checks still pass.
- [ ] **Step 3: Migrate layer mesh vertices, normals, triangle winding, instance transforms and culling bounds** in small domain commits; preserve the existing terrain fallback mesh but ensure it is generated in the same RH frame.
- [ ] **Step 4: Run** `npm run test:terrain`, `npm run test:roads`, `npm run test:village`, `npm run test:vegetation`, `npm run test:water`, `npm run test:focal-sites`, and `npm run build`. Expected: all logical data parity checks pass and surfaces remain outward-facing.
- [ ] **Step 5: Compare** generated logical anchors and RH mesh bounds against the current frame; defer integrated visual captures until Task 5 has migrated all live actors and camera.
- [ ] **Step 6: Commit** as `feat(cartography): migrate static map layers to rh`.

### Task 5: Migrate camera and live actors, then enable one RH scene

**Files:** Modify `src/main.ts`, `src/vehicle/four-wheel.ts`, `src/vehicle/motorcycle.ts`, `src/vehicle/model.ts`, `src/vehicle/motorcycle-model.ts`, `src/player/index.ts`, `src/gameplay/objective.ts`, and `src/environment/atmosphere.ts`; update vehicle/player/minimap checks only where render-facing expectations exist.

**Interfaces:**
- Vehicle/player state, route state and objective anchors remain logical; model-root positions, yaw, camera targets, camera collision rays, light directions, shadows and render culling use converted render values.
- Minimap continues to consume logical position and heading and remains north-up.
- `main.ts` sets `scene.useRightHandedSystem` at construction when `?renderFrame=rh` is present; normal launch stays in the current frame until Task 6 acceptance. In RH mode, it enables either 3D Tiles or fallback terrain, never both at once.

- [ ] **Step 1: Add failing checks** `vehicleForwardRemainsLogicalNorth`, `playerForwardRemainsLogicalNorth`, `chaseCameraFollowsWithoutMirroring`, `minimapRemainsNorthUp`, and `lightDirectionIsReflectedOnce`.
- [ ] **Step 2: Run** focused actor checks, `npm run test:mission`, `npm run test:vehicle-models`, and `npm run test:minimap`; establish expected baseline and ensure the new RH-specific checks fail before conversion.
- [ ] **Step 3: Convert actor root positions/yaw and camera target/collision inputs at their Babylon boundary.** Keep physics, controller, camera chase calculations and minimap inputs in logical coordinates.
- [ ] **Step 4: Add the `?renderFrame=rh` scene-construction option, convert lighting/shadow inputs once, and add the atomic terrain-mode switch:** on successful tileset readiness hide fallback; on load failure or `?terrain=fallback` show fallback. Keep normal launch in its existing mode.
- [ ] **Step 5: Run** `npm run test:vehicle-models`, `npm run test:mission`, `npm run test:minimap`, `npm run test:water`, and `npm run build`. Expected: new heading/camera checks pass, logical mission completion remains unchanged, and only one ground surface is visible.
- [ ] **Step 6: Commit** as `feat(gameplay): preserve actors in rh map scene`.

### Task 6: Verify the integrated map and make it the default

**Files:** Create `scripts/terrain/capture_3d_tiles_map.mjs` and an integrated validator if needed; modify `src/main.ts` default terrain mode and remove `tiles-poc.html`, `src/tiles-poc.ts`, `src/tiles-poc.css`, `scripts/terrain/build_3d_tiles_poc.py`, `public/tiles-poc/` and the prototype-only package configuration after their assets are replaced by the production builder.

- [ ] **Step 1: Run** `npm test`, `npm run build`, `python3 scripts/terrain/build_3d_tiles.py --check`, and `python3 scripts/terrain/validate_3d_tiles.py`. Expected: every domain validator, deterministic data check and production build passes.
- [ ] **Step 2: Capture up to seven browser views** with `scripts/terrain/capture_3d_tiles_map.mjs`: overview, village, road, water/reservoir, vehicle pursuit, on-foot controls and completed mission. Use a task-specific browser profile and write only to `output/3d-tiles-map/`.
- [ ] **Step 3: Verify** zero console errors/404s, correct tile activation while orbiting and zooming, fallback after an intentionally missing tile, 0.01 m tile/heightfield agreement, no visible terrain overlaps, north-up minimap and `COMPLETED` mission report.
- [ ] **Step 4: Fix each screenshot-visible reflection, mismatch, missing layer or seam at its owning task, rerun its focused checks and repeat the integrated capture.** Do not make the tiles default until every acceptance check passes.
- [ ] **Step 5: Set `?renderFrame=rh` and 3D Tiles as the default renderer** only after those checks pass; retain `?terrain=fallback` as the documented debug option.
- [ ] **Step 6: Commit** as `feat(cartography): integrate 3d tiles in playable map`.

## Final Handoff

Report the generated tileset manifest/hash and tile count, focused and full validation results, browser console/network status, mission completion status, and links to the bounded screenshot set. State explicitly that SwiftShader captures verify visual/resource behavior only and do not establish target-GPU performance.
