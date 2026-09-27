# Interactive Minimap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. The minimap module worker must not edit the shared `main.ts` or `index.html`; the orchestrator owns integration. Do not commit, push, publish, deploy, or install.

**Goal:** Add a touch- and mouse-friendly, heading-up minimap that uses the local road network and mission route.

**Architecture:** A Canvas 2D module receives world-coordinate road lines, route points, player position/heading, and landmark labels through a typed API. `main.ts` owns data wiring and frame updates; `index.html` owns layout and accessible controls. The canvas uses no Babylon meshes or external map service.

**Tech Stack:** TypeScript, Canvas 2D, pointer events, existing Babylon game state and OSM road data.

**Spec:** `docs/superpowers/specs/2026-09-27-interactive-minimap-design.md`

## Global Constraints

- Use local OSM/route coordinates; add no external tiles, images, dependencies, or route recalculation.
- Heading points toward the top edge; when heading is invalid, preserve the last stable angle.
- Support drag pan, wheel/pinch zoom, and a recenter control.
- Update at most 10 times per second and add zero Babylon draw calls.
- Keep clear of mobile controls and vehicle selector; preserve keyboard and touch operation.
- No commits, pushes, publishing, deployment, or software installation.

## Review Focus

- Incomplete roads/route and absent heading must not prevent game startup. Test partial inputs and null heading.
- Pan detaches follow mode; recenter restores it. Test drag/recenter ordering.
- Pointer capture and wheel/pinch events must not become driving input. Test touch-like pointers over the minimap.
- Device pixel ratio and resize must not distort hit targets or route rendering. Test narrow/mobile and desktop sizes.
- Canvas must redraw no faster than 10 Hz when idle. Measure timer and draw-call delta.

## Files and ownership

- Agent-owned: create `src/ui/minimap.ts` and `scripts/ui/validate_minimap.mjs`.
- Orchestrator-owned: modify `src/main.ts`, `index.html`, `package.json`; create `scripts/ui/capture_minimap.mjs` and docs.
- Position the panel at `right: 12px; top: 68px` on desktop (188px square) below the vehicle chip; on mobile use the same anchor at 128px square. Give the selector panel a higher z-index so it can cover the map while open. Set `touch-action: none` only on the map canvas, and stop pointer events at the map container so they do not reach vehicle controls.
- Exact component API: `createMinimap(options: MinimapOptions): Minimap`; `Minimap.update(state: MinimapState): void`; `Minimap.dispose(): void`.
- `MinimapOptions` supplies `canvas`, `roads: readonly RoadMapLine[]`, `route: readonly MapPoint[]`, and `labels: readonly LandmarkLabel[]`.
- `MapPoint` is `{ x: number; z: number }`. `LandmarkLabel` is `{ id: string; name: string; x: number; z: number; kind: 'church' | 'square' | 'bar' | 'dam' }`.
- Add exported `RoadMapLine` to `src/road-draping.ts` as `{ id: string; class: RoadClass; points: readonly (readonly [number, number])[] }`; add `RoadNetwork.mapLines(): readonly RoadMapLine[]` backed by the already-parsed road JSON, so no second network request is needed.
- `MinimapState` supplies `x`, `z`, and `headingRad: number | null`.

### Task 1: Implement Canvas map module in isolation

**Files:** Agent-owned `src/ui/minimap.ts`, `scripts/ui/validate_minimap.mjs`.

- [ ] Add the validator cases for route projection, north/heading-up rotation, clamped zoom, pan-follow state, missing heading, and 10 Hz update throttle.
- [ ] Run `node scripts/ui/validate_minimap.mjs` and confirm it fails because the minimap module is absent.
- [ ] Implement the typed API, pointer pan, wheel/pinch zoom, recenter action, and deterministic draw scheduling.
- [ ] Run `node scripts/ui/validate_minimap.mjs` and typecheck. Do not modify integration files.

### Task 2: Wire game data and accessible HUD

**Files:** Orchestrator-owned `src/main.ts`, `index.html`.

- [ ] Add a canvas and named recenter button to the HUD; add desktop and mobile CSS that avoids existing buttons/controls.
- [ ] Add a road-network assertion that `mapLines()` preserves each source line's ID, class and ordered world points; route line comes from `FIRST_ROUTE.polyline`.
- [ ] Pass current vehicle/player pose and mode; use vehicle yaw while driving and available player heading while on foot.
- [ ] Dispose the minimap on game teardown.
- [ ] Register `test:minimap` in `package.json`; run `npm run build`, `npm run test:minimap`, and `npm test`.

### Task 3: Browser interaction and visual validation

**Files:** Create `scripts/ui/capture_minimap.mjs`; modify `package.json`; update `docs/ui/MINIMAP.md`.

- [ ] Verify pan, wheel/pinch zoom, recenter, heading rotation, accessibility labels, and no console errors in the running game.
- [ ] Capture spawn/street at desktop and mobile viewport sizes with the same view before/after.
- [ ] Measure idle update rate, bundle bytes, and Babylon draw-call delta; require ≤10 Hz and +0 draw calls.
- [ ] Run focused and full validators, then request independent read-only screenshot review.
