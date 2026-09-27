# Ortofoto del terreno Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Delegate the bounded data, runtime and validator tasks to the OpenCode models specified below; the orchestrator owns integration and review.

**Goal:** Render a georeferenced PNOA orthophoto over the existing Villafranca terrain so the real field parcels, forest blocks, valley and village are visible in game.

**Architecture:** Capture a fixed PNOA image snapshot covering the terrain bounds, assemble a local north-up WebP atlas, and load it as the shared diffuse texture for the existing terrain meshes. Keep the MDT, height queries, roads, water and gameplay geometry intact; if the atlas is unavailable or unsupported, retain the current vertex-colour terrain.

**Tech Stack:** Python stdlib `urllib`, Pillow, existing Python geospatial environment, TypeScript, Babylon.js 8, existing Vite/CDP capture harness.

**Spec:** `docs/superpowers/specs/2026-09-27-terrain-orthophoto-design.md`

## Global Constraints

- Keep bounds E [471500, 477500] and N [4689000, 4695000] in EPSG:25830; worldX = E − 471500 and worldZ = N − 4689000.
- Build a north-up 6144 × 6144 atlas at approximately 0.98 m/pixel for the 6000 × 6000 m window.
- Keep runtime imagery local; the game must not request imagery from IGN/CNIG.
- Keep the atlas at or below 200 MiB decoded RGBA with mipmaps and the distributed WebP at or below 35 MiB.
- Preserve `heightAt`, `normalAt`, DEM samples, collisions, roads, water, village geometry, vegetation placement, camera, world bounds and culling behavior.
- Share the terrain material and add no draw calls beyond the existing terrain mesh calls.
- Preserve PNOA/IGN/CNIG CC BY 4.0 and OSM ODbL 1.0 attribution; do not put imagery in GLB files.
- Do not add runtime, Python or npm dependencies.

## Review Focus

- **Incomplete or invalid WMS capture:** a partial response, non-image response or incorrect dimensions must stop the build and leave the previous public atlas intact. Pin with mocked response tests in Task 1.
- **Incomplete geographic coverage or unknown source dates:** the source builder must fail when the requested bounds are not covered or the official mosaic metadata cannot identify the imagery. Pin with coverage and metadata checks in Task 1.
- **Reversed north/south or offset atlas:** the atlas bounds, quadrant placement and orientation must match the terrain bounds. Pin with exact output dimensions, manifest extents and quadrant-colour fixtures in Task 2; confirm in the browser in Task 4.
- **Bad/corrupt atlas, incompatible GPU or absent optional field:** the terrain must still load using vertex colours. Pin missing-image and invalid-manifest cases in Task 3; exercise the browser fallback in Task 4.
- **Texture budgets, shading or existing geometry regressions:** verify file and decoded memory budgets, unchanged height samples and active triangle/draw-call counts. Pin static budgets in Task 2 and runtime counters in Task 4.

## Files and ownership

- `scripts/terrain/fetch_pnoa_orthophoto.py` captures and validates immutable WMS source quadrants plus the source manifest; it never changes terrain output. The live official WMS reports a 4096 × 4096 request limit, PNOA 0.25 m data at the village sample, and `OI.MosaicElement` returns date/resolution metadata.
- `data/terrain/raw/pnoa_orthophoto/` stores four captured source images and `source_manifest.json` for offline reproducibility.
- `scripts/terrain/build_terrain_orthophoto.py` deterministically stitches source quadrants and writes the compressed atlas and public manifest; `--check` re-derives and compares hashes without network access.
- `public/terrain/orthophoto.webp` is the only raster loaded by the game; `public/terrain/orthophoto.json` describes its CRS, bounds, dimensions, bytes, hashes, source metadata and licence.
- `scripts/terrain/build_terrain_tiles.py` declares the optional imagery manifest URL in generated terrain config; `src/config.ts` parses it.
- `src/terrain-orthophoto.ts` parses the manifest, maps terrain-grid extents to atlas UVs and loads a validated Babylon texture; `src/terrain.ts` applies the optional texture to its shared material and preserves vertex-colour fallback.
- `scripts/terrain/validate_terrain_orthophoto.py` validates the public asset and its source/attribution/budget manifest; `public/terrain/ATTRIBUTION.md` records the PNOA source; `package.json` exposes all focused checks as `test:terrain-orthophoto` and includes that command in `npm test`.
- `scripts/terrain/test_pnoa_orthophoto_fetch.py` tests WMS response validation and atomic capture behavior with mocked responses. `scripts/terrain/test_terrain_orthophoto_builder.py` tests atlas generation. `scripts/terrain/test_terrain_orthophoto.mjs` tests manifest/UV/runtime fallback behavior.
- `scripts/terrain/capture_terrain_orthophoto.mjs` captures comparable aerial and driving-height views into `output/terrain-orthophoto/` without rewriting `public/terrain/budget.json` or removing another task's Chrome profile; use and clean only its task-specific temporary profile.
- Delegate by file ownership to OpenCode workers: Muse Spark 1.3 Contributor for source capture/building, MiMo V2.6 Flash for the runtime loader, DeepSeek V4.1 Flash for the domain validator and integration review. The orchestrator owns the public interfaces, shared-file integration and final review. Use Space Bunny Free only as an optional read-only reviewer if additional review is useful.

### Task 1: Capture and pin the PNOA source

**Files:** Create `scripts/terrain/fetch_pnoa_orthophoto.py`; create `data/terrain/raw/pnoa_orthophoto/` source captures and manifest.

**Interfaces:**
- Produces `data/terrain/raw/pnoa_orthophoto/{nw,ne,sw,se}.jpg` and `source_manifest.json`.
- The manifest records service URL, WMS version, `OI.OrthoimageCoverage` layer, CC BY 4.0 attribution, exact request BBOX/CRS/dimensions, response MIME type and SHA-256, and official `OI.MosaicElement` date/resolution metadata sampled at every 1 km tile center.

- [ ] **Step 1: Create `scripts/terrain/test_pnoa_orthophoto_fetch.py` with mocked WMS responses.** Add checks named `test_getmap_quadrants_match_config_extent`, `test_rejects_nonimage_content_type`, `test_rejects_bad_image_or_wrong_dimensions`, `test_requires_date_resolution_for_each_tile_center`, and `test_failed_refetch_preserves_previous_snapshot`.
- [ ] **Step 2: Run the source tests and confirm the new checks fail before the fetcher exists.** Run: `python3 scripts/terrain/test_pnoa_orthophoto_fetch.py`. Expected: the fetcher import or requested function is missing.
- [ ] **Step 3: Implement the WMS fetcher.** Query PNOA WMS 1.3.0 `GetCapabilities`; require the `OI.OrthoimageCoverage` and queryable `OI.MosaicElement` layers and respect its 4096 × 4096 maximum. Request four exact EPSG:25830 quadrants, each 3000 × 3000 m rendered at 3072 × 3072 pixels. Query `GetFeatureInfo` for each of the 36 1 km terrain-tile centers to record returned date/resolution metadata. Save responses to temporary files, validate image and metadata, then atomically replace the captured inputs and manifest.
- [ ] **Step 4: Run the source tests and then capture the official imagery once.** Run: `python3 scripts/terrain/test_pnoa_orthophoto_fetch.py`, then `.venv/bin/python scripts/terrain/fetch_pnoa_orthophoto.py`. Expected: all mocked cases pass; four valid source images cover the declared bounds and the manifest contains date/resolution provenance for the sampled tile centers.

### Task 2: Build and validate the static atlas

**Files:** Create `scripts/terrain/build_terrain_orthophoto.py`, `scripts/terrain/validate_terrain_orthophoto.py`, `scripts/terrain/test_terrain_orthophoto_builder.py`, `public/terrain/orthophoto.webp`, and `public/terrain/orthophoto.json`; modify `public/terrain/ATTRIBUTION.md`.

**Interfaces:**
- `build_terrain_orthophoto.py [--check]` reads only the pinned source files from Task 1. Normal mode writes the output; `--check` re-derives to a temporary file and checks exact bytes/SHA-256 against the public manifest without contacting WMS.
- `validate_terrain_orthophoto.py` exits nonzero for any missing or inconsistent source, manifest, asset, attribution or budget field.
- Public manifest contract: `schemaVersion: 1`; `asset: {url, mimeType, width, height, bytes, sha256}`; `coverage: {crs, eMin, eMax, nMin, nMax, pixelSizeM}`; `source: {service, layer, dates, license, attribution, sourceManifestSha256}`.

- [ ] **Step 1: Create `scripts/terrain/test_terrain_orthophoto_builder.py` with quadrant-colour and hash fixtures.** Add checks named `test_nw_ne_sw_se_quadrants_are_placed_north_up`, `test_atlas_dimensions_and_pixel_scale`, `test_manifest_hash_source_and_budgets`, and `test_check_rederives_identical_webp`.
- [ ] **Step 2: Add validator checks for missing fields, exact bounds, 6144 × 6144 WebP dimensions, source hashes, official PNOA/CC BY 4.0 metadata, ≤35 MiB file size and ≤200 MiB decoded RGBA plus mipmaps.** Use temporary fixtures with deliberately flipped quadrants and mismatched hashes to prove invalid inputs fail.
- [ ] **Step 3: Run the builder and validator checks before the implementation exists.** Run: `python3 scripts/terrain/test_terrain_orthophoto_builder.py && python3 scripts/terrain/validate_terrain_orthophoto.py`. Expected: tests fail on the absent implementation and the validator names missing public outputs.
- [ ] **Step 4: Implement deterministic atlas generation.** Place NW/NE/SW/SE captures in the corresponding 3000 m bounds, preserve a north-up orientation, resample only to the specified 6144 × 6144 canvas if needed, convert the input colour profile without stylizing the imagery, and encode `public/terrain/orthophoto.webp` at a quality that meets the file budget. Write the exact public manifest from captured metadata and computed hashes, including the Pillow encoder version used for repeatable `--check`.
- [ ] **Step 5: Run the builder tests, builder check and validator.** Run: `python3 scripts/terrain/test_terrain_orthophoto_builder.py && .venv/bin/python scripts/terrain/build_terrain_orthophoto.py --check && python3 scripts/terrain/validate_terrain_orthophoto.py`. Expected: all pass and report exact output dimensions, bytes, hashes, bounds, decoded memory and attribution.

### Task 3: Load the atlas over the existing terrain

**Files:** Modify `scripts/terrain/build_terrain_tiles.py`, `public/terrain/config.json`, `src/config.ts`, and `src/terrain.ts`; create `src/terrain-orthophoto.ts` and `scripts/terrain/test_terrain_orthophoto.mjs`.

**Interfaces:**
- Add optional `TerrainConfig.orthophotoManifestUrl?: string`; parse and normalize it while keeping old configs valid.
- Emit `orthophotoManifestUrl: "/terrain/orthophoto.json"` from the terrain config builder.
- Export `parseTerrainOrthophotoManifest(raw: unknown, bounds: ProjectedBounds): TerrainOrthophotoManifest`, `terrainTileOrthophotoUV(grid: HeightfieldGrid, bounds: ProjectedBounds): TerrainTileOrthophotoUV`, and `loadTerrainOrthophotoTexture(scene: Scene, manifestUrl: string, bounds: ProjectedBounds, fetchImpl: typeof fetch, createTexture: TerrainTextureFactory): Promise<Texture | null>` from `src/terrain-orthophoto.ts`.
- `TerrainTextureFactory` is `(scene: Scene, url: string, onLoad: () => void, onError: () => void) => Texture`; inject it in tests to force load failure without browser/network access. Validate manifest schema, atlas URL, CRS and bounds before applying the texture.
- `terrainTileOrthophotoUV` maps grid X/Z extents against the matching world-space width/height from `ProjectedBounds`; tests pin the west/south and east/north corners. Share the current terrain material/atlas for every tile. On any imagery error or unsupported `MAX_TEXTURE_SIZE`, use the current vertex-colour path without rejecting `loadTerrain()`.

- [ ] **Step 1: Create `scripts/terrain/test_terrain_orthophoto.mjs` with checks named `test_legacy_config_without_orthophoto_still_parses`, `test_manifest_rejects_mismatched_crs_or_bounds`, `test_tile_uv_maps_all_four_world_edges`, `test_bad_texture_keeps_vertex_colour_fallback`, and `test_gpu_limit_skips_texture_creation`.** Use an injected texture factory to force failure; assert `heightAt` sample values and terrain mesh counts are identical with texture enabled and disabled.
- [ ] **Step 2: Run the focused tests and confirm they fail on the current terrain loader.** Run: `node scripts/terrain/test_terrain_orthophoto.mjs`. Expected: missing imagery config/material behavior is reported before implementation.
- [ ] **Step 3: Add the optional manifest reference to the config type/parser and terrain-config builder.** Regenerate `public/terrain/config.json` using its existing builder; preserve all existing fields and the 36 terrain tile references.
- [ ] **Step 4: Implement manifest/texture loading in `src/terrain-orthophoto.ts` and integrate it into `src/terrain.ts`.** Map UVs per tile, set vertex colours to white only when the texture has loaded, retain the current height palette when it has not, and leave the shared material frozen only after assigning a loaded texture or choosing fallback.
- [ ] **Step 5: Run focused loader tests, terrain validation and type/build checks.** Run: `node scripts/terrain/test_terrain_orthophoto.mjs && npm run test:terrain && npm run build`. Expected: tests pass, terrain bounds/height validation stays unchanged, and TypeScript/Vite builds succeed.

### Task 4: Wire asset validation and produce browser evidence

**Files:** Modify `package.json`; create `scripts/terrain/capture_terrain_orthophoto.mjs`; write screenshots/report under `output/terrain-orthophoto/`.

- [ ] **Step 1: Register `test:terrain-orthophoto` and include the source tests, atlas-builder tests, runtime tests, builder `--check` and asset validator.** Add `npm run test:terrain-orthophoto` to `npm test`; all parts must be independent of network availability.
- [ ] **Step 2: Add repeatable camera presets for the existing terrain-pueblo and terrain-montes aerial views plus one driving-height view.** Reuse CDP setup from `scripts/terrain/capture_terrain.mjs`, use a task-specific temporary Chrome profile, and never write to `public/terrain/budget.json`.
- [ ] **Step 3: Run integrated data checks and the production build.** Run: `npm run test:terrain-orthophoto && npm run test:terrain && npm run build`. Expected: all three succeed with no source-service request during checks.
- [ ] **Step 4: Capture the game and review the images.** Start Vite and run `node scripts/terrain/capture_terrain_orthophoto.mjs --base http://127.0.0.1:5173 --out-dir output/terrain-orthophoto`. Confirm parcel boundaries, forest blocks, town and valley read clearly; inspect quadrant seams, road alignment, texture fallback, browser console errors, active draw calls, visible triangles and unchanged sampled heights.
- [ ] **Step 5: If any visual or budget acceptance criterion fails, fix the responsible task and repeat its checks plus the integrated capture.** Report any unresolved PNOA coverage/date limitation as a blocker; do not substitute invented geographic detail.

## Final Handoff

Report the source acquisition dates/resolution, atlas bytes and decoded-memory estimate, validator/build results, unchanged terrain-height evidence, browser console status, and links to the aerial and driving-height screenshots. Do not make target-GPU FPS claims from headless/SwiftShader captures.
