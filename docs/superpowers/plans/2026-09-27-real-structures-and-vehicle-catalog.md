# Real Structures and Vehicle Catalog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver one playable version with eight distinct vehicles and image-backed corrections to the church, eight pilot houses, plaza, and Alba dam.

**Architecture:** A typed catalog and common vehicle contract feed one active vehicle reference shared by player and game systems; separate four-wheel and motorcycle adapters own their physics and visuals. A switch manager validates and replaces the active instance transactionally. Existing Blender builders and GLB fallbacks remain, while a source ledger ties each visual correction to a dated, located real image and a visible before/after difference.

**Tech Stack:** Strict TypeScript, Babylon.js 8, Vite, Node validators/CDP browser harnesses, Python/Blender builders, existing OSM/IGN assets.

**Spec:** `docs/superpowers/specs/2026-09-27-real-structures-and-vehicle-catalog-design.md`

## Global Constraints

- One joint delivery: 4 off-road vehicles (`estandar`, `patrulla`, `carga`, plus one), 2 cars, 2 playable motorcycles; only one active vehicle instance.
- Preserve the existing three IDs, `?vehicle` priority over `selectedVehicleId`, unknown-ID fallback to `estandar`, mission progress, player occupancy, position and yaw on successful switches.
- Switch only when both absolute longitudinal and lateral speed are at most **0.05 m/s** and destination support/space are valid; rejection leaves active vehicle, selector and storage unchanged.
- The church, every pilot house, plaza and dam each need a dated, located real image, an image-visible discrepancy and a demonstrated correction. A dated/geolocated PNOA orthophoto suffices for plan/roof; only a matching ground photo can justify a facade or other vertical detail. The 1996 church photo does not alone establish the current facade.
- Keep OSM footprints/IDs, IGN terrain and valid LiDAR heights (at least 4 samples), road and water behavior, low-poly style, editable Blender sources, reproducible builders and GLB fallbacks. No El Pájaro parking, photo textures, PNOA pixels in the game, new missions or dependencies.
- Preserve attribution: OSM ODbL 1.0, IGN/CNIG CC BY 4.0, each photo's own rights. Dam photos with reserved rights are reference only and are not packaged.
- Existing GLB ceilings remain **250,000 bytes/3,000 triangles** for all eight pilot houses and **600 KiB/20,000 triangles** for focal sites. Do not invent a 1 m fit tolerance or a new FPS regression threshold.
- Final verification includes `npm test`, `npm run build`, a real browser mission/selector drive, at most **7 useful screenshots total**, and graphic-resource comparisons. FPS claims require target hardware; SwiftShader measurements do not establish them.
- Keep the unrelated untracked `assets/environment/focal-sites/focal-sites.blend1` untouched. Make focused commits for implementation tasks; do not publish or deploy.

## Review Focus

- Invalid persisted/query IDs or unavailable storage: choose `estandar` without throwing or writing an invalid selection (Task 6 tests).
- A stopped vehicle whose destination footprint touches an obstacle, terrain edge or unsafe water: reject without changing player, mission, active ID or resources (Task 5 tests).
- Factory or partial consumer-rebind failure after candidate creation: dispose only the candidate and restore the old active vehicle, camera, controls, HUD and selection (Task 5 tests).
- A fallen motorcycle on slope or during a switch request: no driving/switch exploit; recovery restores a valid supported pose at the current location without mission progress (Tasks 4–5 tests).
- An ortho tile without flight date, a photo without site identity, or a claimed facade correction supported only from above: reject visual completion (Tasks 1 and 7–8 tests).

## Files and ownership

- `src/vehicle/catalog.ts` owns eight typed definitions and IDs; `src/vehicle/types.ts` owns the new common `VehicleActor`, motion and telemetry contracts. Keep the existing four-wheel `Vehicle` type in `src/vehicle/index.ts` until `main.ts` and `player/index.ts` migrate in Task 5; keep `src/vehicle/presets.ts` as a compatibility adapter for the three preset APIs and validator.
- Move the current four-wheel implementation from `src/vehicle/index.ts` to `src/vehicle/four-wheel.ts`; `src/vehicle/index.ts` becomes the category factory. `model.ts`, `physics.ts` and `attitude.ts` remain the four-wheel internals. `motorcycle-physics.ts`, `motorcycle-model.ts` and `motorcycle.ts` own the two-wheel behavior.
- `src/vehicle/switch.ts` owns pose validation and one active reference; `src/player/index.ts` reads that reference rather than a captured vehicle. `src/main.ts` owns bootstrap, selector, water/camera/shadow integration and the commit/rollback boundary; `src/diagnostics.ts`, `src/vehicle/selector.ts` and `index.html` show category-aware state.
- `assets/environment/real-structures/evidence.json` owns per-site/per-house source, date, geolocation, discrepancy and correction records. `scripts/environment/validate_real_structure_evidence.mjs` validates the ledger. Existing `build_village_pilot.py`, `build_focal_sites.py`, `.blend` sources, GLBs, manifests and attribution files remain the only geometry/export path.
- `scripts/vehicle/validate_catalog.mjs`, `validate_motorcycle.mjs`, `validate_switch.mjs` and `drive_catalog.mjs` exercise typed data, pure physics, switch failures and the browser flow. `scripts/environment/capture_focal_sites.mjs` supplies reproducible visual viewpoints. Register only necessary focused commands in `package.json`.

---

### Task 1: Pin real-image evidence before geometry edits

**Files:** Create `assets/environment/real-structures/evidence.json`, `scripts/environment/validate_real_structure_evidence.mjs`; read existing OSM/IGN manifests, `public/village/pilot-houses.json`, `assets/environment/focal-sites/sites.json`.

**Interfaces:** Produce `evidence.targets` keyed by church, eight OSM house IDs, plaza and dam. Each record has `sourceUrl`, `author`, `license`, `capturedAt` (photo date or PNOA flight/coverage date), `locatedBy` (OSM way plus image footprint/coverage), `visibleFeature`, `before`, `proposedCorrection`, `confidence`; source-phase validator checks these fields, final phase also checks `after` and comparison reference.

- [ ] **Step 1: Write failing source validator.** Add `assert.equal(Object.keys(targets).length, 11)` and per-record assertions for dated/located image, visible discrepancy and proposed correction; reject missing flight date, unmatched OSM way, and `facade`/`vertical` claims backed only by orthophoto.
- [ ] **Step 2: Run red check.** `node scripts/environment/validate_real_structure_evidence.mjs --phase=source` → FAIL because the ledger is absent.
- [ ] **Step 3: Research and record evidence.** Use official PNOA coverage/flight metadata and individual photo pages; link the eight house roof/footprint observations separately. Record the 1996 church limit and dam photo rights; do not store third-party image pixels. If a dated/located source or real discrepancy cannot be identified, report that target as a release blocker and continue only independent vehicle tasks.
- [ ] **Step 4: Run green check.** `node scripts/environment/validate_real_structure_evidence.mjs --phase=source` → PASS for all 11 records before any visual asset edit.
- [ ] **Step 5: Commit.** Stage only the ledger and validator; `git commit -m "test(environment): pin real structure evidence"`.

### Task 2: Define the eight-entry catalog and common vehicle contract

**Files:** Create `src/vehicle/catalog.ts`, `src/vehicle/types.ts`, `scripts/vehicle/validate_catalog.mjs`; modify `src/vehicle/presets.ts`, `scripts/vehicle/validate_presets.mjs`, `package.json`.

**Interfaces:** Export `VehicleCategory = 'todoterreno' | 'coche' | 'moto'`, `FourWheelDefinition`, `MotorcycleDefinition`, their union `VehicleDefinition`, `VEHICLE_CATALOG`, `DEFAULT_VEHICLE_ID = 'estandar'`, `vehicleById(id: string): VehicleDefinition | undefined`. Define `VehiclePose = { x: number; z: number; yaw: number }` and new `VehicleActor` with `category`, `root`, common mutable `state` (`x,z,yaw,speed,lateral`), `bodySize: { lengthM: number; widthM: number; heightM: number }`, `contactPoints(pose: VehiclePose): readonly { x: number; z: number }[]`, `exitOffsetM`, `step`, `setInput`, `teleport`, `applyPose`, `telemetry`, `dispose`. The old `Vehicle` remains the four-wheel type until Task 5; keep existing `presetById`/`applyPreset` for compatibility.

- [ ] **Step 1: Write failing catalog test.** Add `assert.deepEqual(categoryCounts, [4, 2, 2])`, `assert.equal(new Set(ids).size, 8)`, `assert.equal(vehicleById('bogus'), undefined)` and legacy-value checks; pin new IDs `explorador`, `turismo`, `rally`, `trail`, `enduro` and finite positive dimensions.
- [ ] **Step 2: Run red check.** `node scripts/vehicle/validate_catalog.mjs` → FAIL because the catalog module is absent.
- [ ] **Step 3: Implement typed definitions.** Put common fields and category-specific four-wheel/motorcycle fields in the catalog; adapt legacy preset exports without changing their old numeric values. Register `test:vehicle-catalog`.
- [ ] **Step 4: Run green checks.** `node scripts/vehicle/validate_catalog.mjs && npm run test:vehicle-presets && npm run typecheck` → PASS; fix old source-pattern validator only where the API legitimately changed.
- [ ] **Step 5: Commit.** `git add src/vehicle/catalog.ts src/vehicle/types.ts src/vehicle/presets.ts scripts/vehicle/validate_catalog.mjs scripts/vehicle/validate_presets.mjs package.json && git commit -m "feat(vehicle): define eight-entry catalog"`.

### Task 3: Preserve four-wheel driving behind the shared factory

**Files:** Create `src/vehicle/four-wheel.ts`; modify `src/vehicle/index.ts`, `src/vehicle/model.ts`, `scripts/vehicle/validate_models.mjs`.

**Interfaces:** `createFourWheelVehicle(options: CreateVehicleOptions, definition: FourWheelDefinition): Vehicle`, where legacy `Vehicle` also satisfies `VehicleActor`; keep `createVehicle(options: CreateVehicleOptions): Vehicle` for existing callers. Task 4 adds a second overload `createVehicle(options: CreateVehicleOptions, definition: VehicleDefinition): VehicleActor` while retaining the first until `main.ts` is migrated in Task 5. Four-wheel telemetry satisfies the common contract while retaining existing diagnostic fields.

- [ ] **Step 1: Write failing adapter check.** Add `assert.equal(vehicle.telemetry().contacts.length, 4)` for each of six definitions, unique silhouette IDs and retained legacy parameter values; check pose/wheel animation and that `dispose()` removes owned meshes/materials.
- [ ] **Step 2: Run red check.** `node scripts/vehicle/validate_models.mjs` → FAIL on the missing six-option adapter assertions.
- [ ] **Step 3: Move and adapt the current actor.** Retain existing `physics.ts`/`attitude.ts`; add `explorador`, `turismo`, `rally` low-poly silhouettes in `model.ts`, with category dimensions from definitions. Keep the old three appearances unchanged and avoid retaining inactive bodies.
- [ ] **Step 4: Run green checks.** `node scripts/vehicle/validate_models.mjs && npm run test:vehicle-presets && npm run typecheck` → PASS; record mesh/triangle counts per active body.
- [ ] **Step 5: Commit.** Stage only task files; `git commit -m "feat(vehicle): adapt six four-wheel vehicles"`.

### Task 4: Add real two-wheel behavior and models

**Files:** Create `src/vehicle/motorcycle-physics.ts`, `motorcycle-model.ts`, `motorcycle.ts`, `scripts/vehicle/validate_motorcycle.mjs`; modify `src/vehicle/index.ts`, `package.json`.

**Interfaces:** `MotorcycleState` extends common motion with `leanRad` and `fallen`; `stepMotorcycle(state: MotorcycleState, input: VehicleInput, dt: number, params: MotorcycleParams, surface: VehicleSurface): void` is pure; `recoverMotorcycle(state: MotorcycleState, params: MotorcycleParams, surface: VehicleSurface): boolean` succeeds only on valid support at its current x/z. `createMotorcycle(options: CreateVehicleOptions, definition: MotorcycleDefinition): VehicleActor` exposes exactly two contacts and rider/camera geometry.

- [ ] **Step 1: Write failing physics/model test.** For both bikes assert `state.speed > 0` after throttle, `Math.sign(state.leanRad) === Math.sign(state.yawRate)` in a stable turn, `fallen === true` after excess instability, unchanged position under fallen throttle, recovery on valid support, and `telemetry.contacts.length === 2`. Assert the one-argument `createVehicle(options)` still creates `estandar` while the two-argument overload creates the requested moto.
- [ ] **Step 2: Run red check.** `node scripts/vehicle/validate_motorcycle.mjs` → FAIL because motorcycle modules are absent.
- [ ] **Step 3: Implement physics then actor/model.** Use terrain normal/height, two longitudinal contacts, wheel spin and steering; tie rendered lean to physical state. Model distinct `trail` and `enduro` silhouettes and explicit rider pose; ensure `dispose()` clears owned Babylon resources. In `src/vehicle/index.ts`, implement both overloads with an optional definition defaulting to catalog `estandar`; dispatch the category only when a definition is supplied. Register `test:motorcycle`.
- [ ] **Step 4: Run green checks.** `npm run test:motorcycle && npm run typecheck && npm run test:vehicle-models` → PASS; inspect a slope and fall/recovery in browser before accepting the pose.
- [ ] **Step 5: Commit.** Stage only task files; `git commit -m "feat(vehicle): add playable motorcycles"`.

### Task 5: Make replacement safe, atomic and visible to the player

**Files:** Create `src/vehicle/switch.ts`, `scripts/vehicle/validate_switch.mjs`; modify `src/player/index.ts`, `src/main.ts`, `src/diagnostics.ts`, `package.json`.

**Interfaces:** `VehicleRef = { current: VehicleActor }`; `validateSwitchPose(current: VehicleActor, target: VehicleDefinition, context: SwitchContext): SwitchCheck` returns a reason or safe pose. `switchVehicle(ref: VehicleRef, target: VehicleDefinition, context: SwitchContext): SwitchResult` constructs, commits or rolls back, then disposes the old actor. `Player` receives `vehicleRef: VehicleRef` and reads it on every step and entry/exit calculation. `SwitchContext` supplies `terrain: VehicleTerrain`, `canPlace(target: VehicleDefinition, pose: VehiclePose): boolean`, `waterSafe(target: VehicleDefinition, pose: VehiclePose): boolean`, `canExit(target: VehicleDefinition, pose: VehiclePose): boolean`, `create(target: VehicleDefinition, pose: VehiclePose): VehicleActor`, `prepareRebind(next: VehicleActor, previous: VehicleActor): PreparedRebind` and `persist(id: string): void`; `PreparedRebind = { commit(): void; rollback(): void }`. Preparation takes snapshots without mutation; `rollback()` is idempotent and restores camera, controls, HUD and shadow bindings even after a partially failed `commit()`. `main.ts` supplies these from current world rules.

- [ ] **Step 1: Write failing switch tests.** Assert `validateSwitchPose(...).ok === false` when either `abs(speed)` or `abs(lateral)` exceeds `0.05`, or support/space/water is invalid or a moto is fallen. Inject a `commit()` that changes camera, controls and HUD before throwing; assert `rollback()` restores each snapshot, `ref.current === old`, old x/z/yaw/occupancy/mission/storage unchanged and candidate disposed. Also test create failure, repeated idempotent rollback and on-foot/driving success.
- [ ] **Step 2: Run red check.** `node scripts/vehicle/validate_switch.mjs` → FAIL because the switch module is absent.
- [ ] **Step 3: Implement validation and transaction.** Sample target contacts and footprint against current terrain, village/road obstacles and water rules; recheck speed before commit. Keep candidate disabled in scene; call `prepareRebind` before publishing `ref.current`, then enable candidate and call `commit()`. On any commit error, call idempotent `rollback()`, restore `ref.current` and previous scene enablement, then dispose candidate; dispose old actor and persist ID only after success. Make storage unavailability nonfatal. Migrate `main.ts`/`player/index.ts` to `VehicleActor` and explicit `createVehicle(options, vehicleById(wanted) ?? vehicleById(DEFAULT_VEHICLE_ID)!)`; replace direct legacy `vehicle.params` selection, narrow debug `params()/setParams()` to four-wheel actors, and accept common telemetry in `diagnostics.ts` so Task 5 typechecks. No mission reset or horizontal teleport.
- [ ] **Step 4: Run green checks.** `node scripts/vehicle/validate_switch.mjs && npm run typecheck && npm run test:mission` → PASS; force failure after partial camera/control/HUD rebind in browser and verify the restored old actor remains usable.
- [ ] **Step 5: Commit.** Stage only task files; `git commit -m "feat(vehicle): switch active vehicle atomically"`.

### Task 6: Connect catalog selection, HUD, camera and browser debug API

**Files:** Modify `src/vehicle/selector.ts`, `src/diagnostics.ts`, `src/main.ts`, `index.html`, `scripts/vehicle/validate_selector.mjs`, `scripts/vehicle/drive_selector.mjs`.

**Interfaces:** Selector callbacks request IDs through Task 5 `switchVehicle`; `setCurrent(id)` follows `VehicleRef.current`. `formatVehicleHud(telemetry)` narrows on category. Preserve `window.__game.vehicle` methods used by existing harnesses; `preset()`/`setPreset()` remain aliases for active ID/selection, and four-wheel `params()`/`setParams()` retain their existing behavior.

- [ ] **Step 1: Write failing selector/browser checks.** Assert `groups.length === 3`, `cards.length === 8`, URL-over-storage precedence and `activeId === 'estandar'` for invalid query/storage; cover keyboard/touch selection, unavailable storage, rejection with unchanged card/storage, car/moto HUD fields and category-appropriate camera/entry/exit.
- [ ] **Step 2: Run red checks.** `npm run test:vehicle-selector` and `node scripts/vehicle/drive_selector.mjs` against a local Vite/preview server → FAIL on eight-card/category expectations.
- [ ] **Step 3: Wire UI and consumers.** Route all selection paths through Task 5; use active reference for camera, minimap, water/rescue, diagnostics, shadow list and debug API. Dispose/rebuild owned shadow references on replacement. Keep mission and player controls unchanged except for active-vehicle lookup.
- [ ] **Step 4: Run green checks.** `npm run test:vehicle-selector && npm run test:vehicle-presets && npm run typecheck`, then `node scripts/vehicle/drive_selector.mjs` with the server running → PASS with no console errors.
- [ ] **Step 5: Commit.** Stage only task files; `git commit -m "feat(vehicle): connect eight-option selector and HUD"`.

### Task 7: Correct every pilot house from dated PNOA evidence

**Files:** Modify `scripts/environment/build_village_pilot.py`, `assets/environment/village-pilot/village-pilot.blend`, `public/village/pilot-houses.glb`, `public/village/pilot-houses.json`, `assets/environment/real-structures/evidence.json`, `scripts/environment/validate_village_pilot.mjs`, `docs/environment/VILLAGE_PILOT.md`.

**Interfaces:** Each house evidence record supplies its OSM ID and observed roof/footprint correction to the builder; the builder remains authoritative for GLB and manifest. No facade becomes `corrected` without an image of that same facade.

- [ ] **Step 1: Write failing per-house validation.** Assert `houses.length === 8` and, per ID, dated/geolocated PNOA roof/footprint observation, before-versus-image discrepancy and changed geometry. Assert `lidarSampleCount >= 4` for LiDAR heights, `facadeTreatment.includes('aproximada')` without matching ground photo, and GLB <=250,000 bytes/3,000 triangles.
- [ ] **Step 2: Run red check.** `npm run test:village-pilot && node scripts/environment/validate_real_structure_evidence.mjs --phase=final` → FAIL on missing documented corrections.
- [ ] **Step 3: Update the builder from measured image-visible geometry.** Correct each roof/plan separately, preserving OSM IDs/footprints and valid LiDAR; do not relabel guessed walls. Regenerate with `/usr/bin/blender --background --factory-startup --python scripts/environment/build_village_pilot.py` and record `after` plus comparable evidence references.
- [ ] **Step 4: Run green checks.** `npm run test:village-pilot && npm run test:village && npm run typecheck` → PASS; inspect each house before/after in reproducible village views.
- [ ] **Step 5: Commit.** Stage only task files; `git commit -m "feat(environment): correct eight pilot roofs from PNOA"`.

### Task 8: Correct church, plaza and dam with source-limited geometry

**Files:** Modify `assets/environment/focal-sites/sites.json`, `scripts/environment/build_focal_sites.py`, `assets/environment/focal-sites/focal-sites.blend`, `public/village/focal-sites/*.glb`, `public/village/focal-sites/manifest.json`, `src/environment/village-landmarks.ts`, `scripts/environment/validate_focal_sites.mjs`, `assets/environment/real-structures/evidence.json`, `docs/environment/VILLAGE_LANDMARKS.md`, `public/village/ATTRIBUTION.md`.

**Interfaces:** Task 1 evidence records drive site-level corrections. Existing loader retains per-site fallback; updated manifest bytes/hashes must match loader accounting. Plaza/road and dam/water geometry contracts remain unchanged.

- [ ] **Step 1: Write failing site checks.** Assert `sites.length === 3`, each with dated/located image and before/after visible correction; reject church current-facade claims based only on 1996 photo and plaza/dam vertical claims based only on ortho. Assert parking absent, valid licenses/fallback, no duplicate church/wall, and total GLBs <=600 KiB/20,000 triangles.
- [ ] **Step 2: Run red check.** `npm run test:focal-sites && node scripts/environment/validate_real_structure_evidence.mjs --phase=final` → FAIL on missing site correction evidence.
- [ ] **Step 3: Apply only supported changes.** Correct church observed persistent/dated features or plan, plaza plan, and dam plan from the corresponding images. Keep street collision, water depth/base/crest and unknown vertical details; regenerate with `/usr/bin/blender --background --factory-startup --python scripts/environment/build_focal_sites.py`. Update source ledger, manifests, loader byte counts and attribution; never add rights-reserved pixels.
- [ ] **Step 4: Run green checks.** `npm run test:focal-sites && npm run test:water && node scripts/environment/validate_real_structure_evidence.mjs --phase=final && npm run typecheck` → PASS; browser-check GLB failure fallbacks and visible corrections.
- [ ] **Step 5: Commit.** Stage only task files, excluding `focal-sites.blend1`; `git commit -m "feat(environment): correct focal sites from real imagery"`.

### Task 9: Verify the single playable delivery

**Files:** Create `scripts/vehicle/drive_catalog.mjs`; modify `package.json` and the final evidence notes in `docs/vehicle/VALIDACION_FASE4.md` and `docs/environment/VILLAGE_LANDMARKS.md` only as needed. Keep generated capture/report files under ignored `output/`.

**Interfaces:** Browser harness reads `window.__game` and exercises all eight IDs, switch rejection/rollback, motorcycle recovery and mission flow; it reports resource counters and screenshot paths. A separate four-site visual check links ledger sources to reproducible before/after views.

- [ ] **Step 1: Write failing end-to-end assertions.** Assert `drivableIds.length === 8` after flat/slope/turn drives, both motos lean/fall/recover, and mission state `COMPLETED` for a car and moto after on-foot interaction. After ten cross-category switches back to the initial ID, assert one actor and baseline-owned resource counts; moving/invalid-support/space rejection preserves state/storage, and console errors are zero.
- [ ] **Step 2: Run red browser check.** Start `npm run dev` and run `node scripts/vehicle/drive_catalog.mjs` → FAIL on any missing flow; retain the failure report for diagnosis.
- [ ] **Step 3: Fix only integration defects exposed by the harness.** Keep ownership with the relevant earlier task files; use up to **7 useful screenshots total**: one before/after house overview covering all eight, one each for church/plaza/dam, and up to three vehicle views. Link each of the 11 image-backed corrections to its before/after evidence; if one lacks a real visible correction, report the joint delivery incomplete.
- [ ] **Step 4: Run final gates.** `npm test && npm run build && node scripts/vehicle/drive_catalog.mjs` with the dev server running → PASS. Compare bytes, draw calls, meshes/triangles and owned resources before/after switching. Report FPS only if captured on target hardware; mark SwiftShader frame times as nonrepresentative.
- [ ] **Step 5: Commit.** Stage harness, package script and evidence notes only; `git commit -m "test(gameplay): verify joint vehicle and structure delivery"`. Check `git status --short` leaves only pre-existing unrelated files.
