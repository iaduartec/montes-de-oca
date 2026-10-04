# V13 road visual pair / vehicle art classes
STATUS: DELIVERED / ACCEPTED_SCOPED — pavement fix and fresh eight-vehicle runtime audit
WORKER: Codex / road_pair_review
MODEL: GPT-6 Luna / gpt-6-luna
OWNED FILES: scripts/roads/capture_junction_pair.mjs; outputs/village-fidelity-20261004/road-visual-pair/; docs/vehicles/VEHICLE_ART_AUDIT.md
OBJECTIVE: Actual matching road junction and cut-edge views from frozen isolated before/after source builds; classify eight vehicles with source and runtime evidence.
READ ONLY: live source and baseline snapshots; no swapping live files.
CONTRACT: exact same camera/FOV/preset/resolution and all other source hashes; distinguish thin-face normal ratio from actual cut-height or visible wedge regression.
VALIDATION: native CDP screenshots inspected; rendered triangle references; existing drive_catalog.
FORBIDDEN: other edits; subagents; commits; unverified FINAL assets; software FPS as hardware evidence.
REPORT: STATUS / FILES / WHAT / VERIFY / RISKS / BLOCKERS.

FOLLOW-UP DELIVERY: native cold boot review passes dev/build without exceptions. Fixed catalogue readiness (reject zero resources, await rendered frames) and obsolete normal-turn fall expectation. Fresh built run: eight IDs drove/switched, positive/stable counts, GLB loaded, visible captures, no console errors. Source physics unchanged. outputs/village-fidelity-20261004/vehicle-catalog-final/ and native-boot-review/.
