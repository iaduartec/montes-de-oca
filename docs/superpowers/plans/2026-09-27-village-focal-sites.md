# Hitos del entorno Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to execute tasks in order. Do not commit, push, publish, or deploy; the owner will integrate in the current worktree.

**Goal:** Model the church and plaza first, then El Pájaro parking, then add low-poly detail to the existing Alba dam.

**Architecture:** Keep current OSM/IGN ground truth and village/water builders. Add site assets as independently culled Blender GLBs with a small runtime loader; only replace the generic church mesh or base dam wall when its corresponding GLB loads successfully. Keep one writer (the orchestrator) for `village.ts`, `water.ts`, `main.ts`, generated assets, and shared integration.

**Tech Stack:** TypeScript, Babylon.js, existing `@babylonjs/loaders`, Blender at `/usr/bin/blender`, existing OSM/LiDAR JSON and IGN PNOA comparator.

**Spec:** `docs/superpowers/specs/2026-09-27-village-focal-sites-design.md`

## Global Constraints

- Preserve the current dirty `src/environment/village.ts` diff and the house-pilot GLB/fallback.
- Preserve OSM ODbL 1.0 and IGN/CNIG CC BY 4.0 attribution; document the Wikimedia reference author and CC BY-SA 4.0 terms.
- Do not copy Google imagery/tiles/geometry or put PNOA imagery in the game.
- Do not alter terrain, road meshes, water depth/physics, mission, or driving controls.
- Keep up to 2 new draw calls per site, 20,000 new triangles total, and 600 KiB total GLB payload.
- Do not commit, push, publish, deploy, or install software.

## Review Focus

- A failed/missing church GLB must leave the existing church builder visible. Test asset failure and verify the church is not hidden.
- The current 12.8 m church height is heuristic, not LiDAR measured. Verify the manifest labels this source correctly.
- The parking polygon is not in local OSM. Test that only a documented PNOA/IGN-observed polygon is used and no imagery is bundled.
- Plaza assets must not overlap road/collision meshes. Capture and inspect alignment at ground level.
- A detailed dam asset replaces the base dam mesh when loaded; failed/missing asset keeps the base mesh. Test both paths to prevent z-fighting/double rendering.
- Dam replacement must not alter water levels, depth grid/`depthAt`, vehicle water rules, or terrain DEM. Run existing water validator.

## Files and ownership

- Create `assets/environment/focal-sites/` Blender sources for the church, plaza props, parking, and dam details.
- Create `scripts/environment/build_focal_sites.py` to export deterministic GLBs/manifests and `scripts/environment/validate_focal_sites.mjs` for bounds, attribution, hashes, size, and triangle budgets.
- Create `public/village/focal-sites/` GLBs and manifest.
- Create `src/environment/village-landmarks.ts` for isolated site loading and lifecycle; modify `src/environment/village.ts` only to allow successful external replacements to suppress generic buildings.
- Modify `src/environment/water.ts` to accept `includeDam?: boolean` (default `true`), suppressing only the flat wall mesh when the detailed wall asset has loaded.
- Modify `src/main.ts` only for load order and disposal integration; load landmarks before water/village so each fallback decision is known; orchestrator owns this shared file.
- Create `scripts/environment/capture_focal_sites.mjs` for repeatable before/after camera views.
- Modify `package.json` only in the integration task to register `test:focal-sites`.

### Task 1: Capture baselines and pin site data

**Files:** Create `scripts/environment/capture_focal_sites.mjs`; create a small source manifest in `assets/environment/focal-sites/sites.json`.

- [ ] Record the church footprint/height-source, plaza ways, dam way, and PNOA/IGN observation metadata for El Pájaro parking.
- [ ] Add fixed camera presets for church/plaza, parking, and dam to the capture script; run once before site changes and retain under `output/focal-sites-before/`.
- [ ] Verify all world coordinates derive from local OSM/IGN or an explicitly documented manual PNOA trace; leave uncertain parking striping/curbs out.

### Task 2: Build the church and plaza assets

**Files:** Create Blender source(s) in `assets/environment/focal-sites/`; create GLB and metadata output under `public/village/focal-sites/`; create `scripts/environment/build_focal_sites.py` and `scripts/environment/validate_focal_sites.mjs`; modify `package.json` to register the focused validator.

- [ ] Add validator assertions for church ID `90614388`, plaza ways `645040295`/`741760074`, artist approximation label, ODbL/CC BY attribution, and CC BY-SA photo credit.
- [ ] Run `node scripts/environment/validate_focal_sites.mjs` and confirm it fails because the church/plaza assets and metadata are not yet present.
- [ ] Model the church silhouette from the OSM polygon and licensed photo reference; encode the 12.8 m height as heuristic metadata and use low-poly vertex colors.
- [ ] Add only plaza furniture confirmed by reference, merged by material and separate from road geometry/collisions.
- [ ] Register `test:focal-sites` in `package.json`; export with `/usr/bin/blender --background --factory-startup --python scripts/environment/build_focal_sites.py` and run `npm run test:focal-sites`.

### Task 3: Load church/plaza with safe fallback

**Files:** Create `src/environment/village-landmarks.ts`; modify `src/environment/village.ts` and `src/main.ts`.

- [ ] Add `loadVillageLandmarks(scene, terrain, options?): Promise<VillageLandmarks>`; expose `stats`, `coveredBuildingIds`, `replacesDam`, and `dispose()`.
- [ ] Add optional `omitBuildingIds?: ReadonlySet<number>` to `LoadVillageOptions`; only pass ID `90614388` after successful church asset loading.
- [ ] Add browser validation that missing/corrupt asset keeps the generic church and that successful load draws the church only once.
- [ ] Load landmarks before `loadWater`/`loadVillage`; pass `includeDam: !landmarks.replacesDam` to water and `landmarks.coveredBuildingIds` to village. Load plaza props without collision meshes, catch failures per site, and dispose all loaded containers during shutdown.
- [ ] Run focal-site validator, village pilot validator, `npm run build`, `npm test`, and before/after church/plaza captures.

### Task 4: Add El Pájaro parking

**Files:** Modify only the focal-sites Blender source/manifest/builder/validator and `src/environment/village-landmarks.ts`.

- [ ] Trace the parking outline manually against the official PNOA comparator and local world-coordinate reference; record imagery date, bounds, and confidence in the source manifest.
- [ ] Add one low-poly surface/prop batch; omit unverified painted lines or furniture.
- [ ] Add validator checks for documented location, no raster imagery in outputs, draw-call/triangle/size budgets, and asset attribution.
- [ ] Capture parking before/after from the same camera; run `npm run test:focal-sites` and `npm run build`.

### Task 5: Add dam details

**Files:** Modify focal-sites Blender source/manifest/builder/validator and `src/environment/village-landmarks.ts`; do not modify `src/environment/water.ts` unless a verified attachment point requires it.

- [ ] Build the detailed dam wall from way `168459142` and `water.json` endpoints/base/crest; use it as a full replacement for the flat mesh only after successful asset load. Label unverified architectural details as approximate.
- [ ] Add a failing-then-passing check for `loadWater({ includeDam: false })`: decorative sheets/ribbons and the depth API remain, and only the base wall mesh is omitted.
- [ ] Test unchanged `water.json`, dam endpoints, and `depthAt` output against the pre-change snapshot.
- [ ] Capture dam before/after; run focal-site and water validators, `npm run build`, `npm test`, and the three-site visual review.

### Task 6: Final site integration and performance report

**Files:** Update `docs/environment/VILLAGE_LANDMARKS.md`, public attribution manifest, capture outputs.

- [ ] Record bytes, hashes, meshes, triangles, draw-call delta and the exact source/license of each used photo/geo input.
- [ ] Confirm combined assets meet 600 KiB, 20,000 triangles, and 2 draw calls per site; reduce geometry if any limit is exceeded.
- [ ] Review the final screenshots independently without edits to source/assets, and report any mismatch as a blocker before handoff.
