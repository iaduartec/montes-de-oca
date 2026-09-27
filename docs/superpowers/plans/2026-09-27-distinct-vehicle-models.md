# Distinct Vehicle Models Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. AGY owns only `src/vehicle/model.ts` and `scripts/vehicle/validate_vehicle_models.mjs`; the orchestrator owns `src/vehicle/index.ts`, presets, selector, `main.ts`, and HTML. Do not commit, push, publish, deploy, or install.

**Goal:** Give Estándar, Patrulla, and Carga distinct low-poly silhouettes while preserving current physics, driving state, and selector behavior.

**Architecture:** `VehicleModel` gains an appearance switch that updates geometry on the existing material-grouped body mesh objects while retaining root, child mesh identities, wheels, wheel hubs, shadow references, and animation. `Vehicle` exposes the switch; presets map to appearance IDs, and the existing selection flow applies visual and physical preset data together.

**Tech Stack:** TypeScript, Babylon.js procedural meshes, existing vehicle presets and selector.

**Spec:** `docs/superpowers/specs/2026-09-27-distinct-vehicle-models-design.md`

## Global Constraints

- Preserve physics preset values, vehicle state, mission state, wheel layout and input bindings.
- Keep static details merged by material; retain four independently animated wheels.
- Limit each body to 2,500 triangles; active body adds at most 2 draw calls over current vehicle.
- Invalid appearance falls back to `estandar`; hidden old bodies must be disposed, not accumulated.
- Do not commit, push, publish, deploy, or install software.

## Review Focus

- Switching while moving must preserve position, velocity, yaw, steering, player occupancy, and mission state. Test a live switch.
- Repeated switching must not accumulate meshes/materials or leave stale shadow-render-list references. Test a multi-preset cycle and confirm active body mesh objects retain identity.
- Unknown visual IDs must leave valid physics selection intact and display standard body. Test unknown appearance separately from unknown preset.
- All body variants must keep wheels attached through terrain pitch/roll and steering. Test browser capture on sloped ground.
- Preset storage/query selection and keyboard/touch selector must remain unchanged. Run current preset and selector validators.

## Files and ownership

- AGY-owned: modify `src/vehicle/model.ts`, create `scripts/vehicle/validate_vehicle_models.mjs`.
- Orchestrator-owned: modify `src/vehicle/index.ts`, `src/vehicle/presets.ts`, `src/main.ts`, `src/vehicle/selector.ts`, `index.html`, `package.json`; create `scripts/vehicle/capture_vehicle_models.mjs` and update docs.
- Exact model contract: `VehicleModel.setAppearance(id: string): VehicleAppearanceId`; `VehicleAppearanceId = 'estandar' | 'patrulla' | 'carga'`; `Vehicle.setAppearance(id: string): VehicleAppearanceId`.
- Appearance definitions do not include physics values; `applyPreset` remains the source of physics values.

### Task 1: Build and validate procedural body variants

**Files:** AGY-owned `src/vehicle/model.ts`, `scripts/vehicle/validate_vehicle_models.mjs`.

- [ ] Add validator assertions for all three appearance IDs, silhouette-specific feature labels, triangle budget, merged static groups, stable wheel hubs, unknown-ID fallback, and disposal.
- [ ] Run `node scripts/vehicle/validate_vehicle_models.mjs` and confirm it fails because appearance switching is not implemented.
- [ ] Add `VehicleAppearanceId` and `VehicleModel.setAppearance`; update vertex/index buffers in the existing body mesh objects so `vehicle.root`, mesh identities, and the atmosphere's shadow-caster references remain stable.
- [ ] Implement Standard (current body), Patrol (distinct utility body), and Cargo (extended load body), each ≤2,500 triangles.
- [ ] Run model validator and typecheck; return a report with files touched and measured triangle/draw-call counts. Do not edit integration files.

### Task 2: Integrate model and physics selection

**Files:** Orchestrator-owned `src/vehicle/index.ts`, `src/vehicle/presets.ts`, `src/main.ts`.

- [ ] Add `Vehicle.setAppearance`; initialize Estándar when the vehicle is created.
- [ ] Add appearance IDs to existing presets without changing any physics number.
- [ ] In `aplicarPreset`, apply physics values and appearance while preserving all mutable `VehicleState` fields.
- [ ] Extend preset validation to assert exact pre-existing physics values and appearance mapping; add a browser test for switching while moving.
- [ ] Run model, preset and selector validators, typecheck and build.

### Task 3: Show vehicle identities and capture results

**Files:** Orchestrator-owned `src/vehicle/selector.ts`, `index.html`, `package.json`; create `scripts/vehicle/capture_vehicle_models.mjs`; update vehicle docs.

- [ ] Add concise appearance descriptions to selector cards and ensure each visual identity matches its preset name.
- [ ] Capture all three models at identical camera positions, both at spawn and on a slope; check wheels and mesh counts.
- [ ] Register `test:vehicle-models` in `package.json`; run model, selector and preset validators plus full `npm test`; report bytes (0 external asset bytes), triangles, draw calls and desktop/mobile observations if available.
