# Vehicle catalogue art audit

Snapshot: 2026-10-04, source HEAD `349d98494c1108060e6a0cf7f87f4803701c6a07`. This is a source and capture audit, not a claim that eight finished vehicle assets are present.

The runtime catalogue has eight selectable IDs across three driving categories. The source tree contains one external vehicle GLB, `public/vehicles/four-door-utility.glb`. `estandar` and `patrulla` both try to use it; the other six IDs are assembled from procedural Babylon meshes. The catalogue proves that eight variants can be selected and driven. It does not prove eight separately authored, licensed, make-accurate models.

| ID | Display name / category | Current visible model path | Art evidence and limits |
|---|---|---|---|
| `estandar` | SUV 4x4 utilitario / todoterreno | Generic utility SUV GLB when async loading succeeds; procedural SUV fallback while loading or after load failure. | The GLB has no make branding. The 2026-10-04 playable spawn capture shows a boxy green utility 4x4, but its report does not prove whether the async GLB had replaced the fallback. |
| `patrulla` | Todoterreno de servicio / todoterreno | Same generic utility SUV GLB as `estandar`; its own five-door procedural fallback. | The fallback comments borrow Nissan Patrol Y61 cues. Neither the shared GLB nor a sourced Nissan model supports presenting it as a real Patrol. |
| `carga` | Jeep Wrangler TJ / todoterreno | Procedural geometry: short body, hardtop, upright front, seven grille slots, round lamps, hinges, spare. | Wrangler is the design intent in code, not a sourced or validated Jeep asset. No separate vehicle GLB is attached. |
| `explorador` | Citroën AX / coche | Procedural compact hatchback geometry. | AX proportions and styling are code comments and dimensions; there is no supplied Citroën model or brand-source record. |
| `turismo` | Audi A4 B5 / coche | Procedural four-door sedan geometry. | The existing category capture is a distant rear view; it does not establish A4-specific fidelity. No sourced Audi model is present. |
| `rally` | Tesla Model 3 / coche | Procedural low sedan with a long glass roof cue. | The source describes Model 3 styling, but contains no sourced Tesla geometry, badges, or make-specific validation. |
| `trail` | Trail / moto | Procedural segmented dual-sport motorcycle, with frame, tank, fenders, spokes, knobby tires, engine and rider anchors. | Code comments describe Honda CRF300L cues. No Honda asset, reference pack, or make-specific license record is present; existing image is too small for detailed review. |
| `enduro` | Enduro / moto | Procedural segmented motocross motorcycle, sharing the motorcycle builder with different orange plastics, dimensions and front number plate. | Code comments describe KTM 450 SX-F cues. No KTM asset or make-specific source record is present. |

## Evidence checked

- The catalogue and display names are in [`src/vehicle/catalog.ts`](../../src/vehicle/catalog.ts) and [`src/vehicle/presets.ts`](../../src/vehicle/presets.ts). The two motorcycle records are the final two catalogue entries; three legacy 4x4 entries are followed by three car entries.
- [`src/vehicle/model.ts`](../../src/vehicle/model.ts) defines procedural four-wheel bodies. `estandar` and `patrulla` share `buildUtilityWithGlbFallback`; `carga`, `explorador`, `turismo`, and `rally` dispatch to separate procedural builders. [`src/vehicle/motorcycle-model.ts`](../../src/vehicle/motorcycle-model.ts) constructs both motorcycle variants from Babylon boxes, cylinders and tubes.
- [`public/vehicles/ATTRIBUTION.md`](../../public/vehicles/ATTRIBUTION.md) records the GLB provider's CC0 and AI-origin statements as listing claims, explicitly not independently verified. It describes a generic, unbranded SUV and therefore does not substantiate any manufacturer name.
- The older [`output/vehicle_catalog.json`](../../output/vehicle_catalog.json) records all eight IDs changing successfully and moving under throttle, both motorcycles falling and recovering, unchanged scene vertices/triangles after repeated vehicle switches, and no console errors. It was generated on 2026-09-29 against `http://127.0.0.1:5173`. It has only three category screenshots and its `visual_audit_estandar` field is absent, so it does not prove GLB load success or provide a close visual for every ID. Its whole-scene counts (130 draw calls, 773,372 triangles, 1,891,751 vertices) are from headless SwiftShader; FPS/frame time are not representative of a target GPU.
- Current playable baseline capture is [`outputs/village-fidelity-20261004/before/spawn.png`](../../outputs/village-fidelity-20261004/before/spawn.png), with telemetry in [`capture-report.json`](../../outputs/village-fidelity-20261004/before/capture-report.json). The screenshot includes the player, default 4x4 and a village NPC. Its 196 draw calls, 1,931,470 triangles, 1,311,573 vertices and 42 textures describe the full scene, not the vehicle alone. Backend is SwiftShader. It also does not expose a vehicle GLB-loaded flag.
- For actor context, [`assets/characters/kenney-animated-characters-3/asset.json`](../../assets/characters/kenney-animated-characters-3/asset.json) records Kenney's humanoid model as CC0 1.0 and says the Walk clip was retargeted from the Quaternius CC0 Universal Animation Library. [`src/environment/village-npcs.ts`](../../src/environment/village-npcs.ts) loads that same player GLB for the NPCs and starts their Idle/Walk groups. These are stylized game characters; the visible screenshot does not establish photorealistic humans.

## Audit decision

Treat the catalogue as eight playable variants, with one shared generic SUV asset path and six procedural models. Keep manufacturer names classified as unverified styling labels unless a matching asset, source, and license record are added and its rendered silhouette is reviewed. The current evidence supports drivability and switch-resource stability, but a fresh stable-source capture of every ID is still needed for a complete visual acceptance pass.

## Fresh runtime audit and art classifications (2026-10-04)

`FINAL` means sourced, make-accurate art with a reviewed rendered capture. `ACCEPTABLE STYLIZED` means a recognizable, intentionally unbranded game vehicle asset whose runtime load and rendered silhouette are confirmed. `PLACEHOLDER` means make-specific art or its visual acceptance remains incomplete. No entry reaches `FINAL` in this audit.

| ID | Classification | Current evidence and limit |
|---|---|---|
| `estandar` | **ACCEPTABLE STYLIZED** | The rendered category capture shows a recognizable unbranded utility 4x4. The runtime audit confirms its generic GLB loaded (30 meshes; wheel centers within 0.002 m of the 0.38 m radius clearance). It is not make-specific art. |
| `patrulla` | **PLACEHOLDER** | Shares the generic SUV model path, but the fresh category capture does not show a patrol-specific livery, equipment, or individually reviewed silhouette. Nissan styling remains an unverified label. |
| `carga` | **PLACEHOLDER** | Procedural Wrangler-inspired geometry; no sourced Jeep asset or individual rendered capture. |
| `explorador` | **PLACEHOLDER** | Procedural AX-inspired hatchback; no sourced Citroën asset or individual rendered capture. |
| `turismo` | **PLACEHOLDER** | The category capture shows a rendered procedural sedan, but does not establish Audi A4-specific styling or final art quality. |
| `rally` | **PLACEHOLDER** | Procedural Model 3-inspired sedan; no sourced Tesla asset or individual rendered capture. |
| `trail` | **PLACEHOLDER** | The category capture shows the rendered procedural motorcycle; it does not establish CRF300L-specific styling or final art quality. |
| `enduro` | **PLACEHOLDER** | Procedural KTM-inspired motorcycle; no sourced KTM asset or individual rendered capture. |

The fresh actual-catalogue run used the isolated production preview at `http://127.0.0.1:4199` and is saved at [`vehicle_catalog.json`](../../outputs/village-fidelity-20261004/vehicle-catalog-final/vehicle_catalog.json), with three visible category captures and two brake-light captures in the same directory. All eight IDs drove and switched, entry/exit checks passed, the generic utility GLB loaded, scene triangle/vertex counts returned unchanged after eleven switches, and the harness recorded no console errors. The baseline and final snapshots both had 196 draw calls, 1,933,730 triangles, 1,314,179 vertices, and 101 active meshes.

The previous run at [`road-visual-pair/vehicle_catalog`](../../outputs/village-fidelity-20261004/road-visual-pair/vehicle_catalog/vehicle_catalog.json) is retained as rejected diagnostic evidence: its readiness gate accepted unchanged zero-resource samples and captured before the scene rendered. The gate now requires positive finite frame/resource metrics, repeated browser animation frames, and post-mutation frames before screenshots. The fresh motorcycle check now tests the user-facing ordinary hard-turn contract: each bike leans with the turn without falling, then returns upright under handbraking. It does not claim a fallen-state recovery in the browser; fallen-state recovery remains covered by [`validate_motorcycle.mjs`](../../scripts/vehicle/validate_motorcycle.mjs). No model is classified `FINAL`.
