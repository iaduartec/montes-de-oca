# V2 evidence based village overrides (fallback worker)
STATUS: ACCEPTED_SCOPED — four roof profiles plus hospital appearance; compound volumes remain approximate
WORKER: Codex / village_audit
MODEL: GPT-6 Luna / gpt-6-luna
REPO: /home/kiri_/projects/montes-de-oca-offroad
BASELINE: HEAD 349d984 plus preserved local changes.
OBJECTIVE: Three independently reviewed PNOA roof shape corrections (818885706, 818885708, 474364245), ridge-axis correction 474649085, Antiguo Hospital 672017718 roof appearance. Preserve no-op gable control 310174514.
OWNED FILES: src/environment/village-roof-geometry.ts; src/environment/village.ts; src/environment/village-facade-kits.ts; src/environment/roof-shape.ts; src/environment/village-building-overrides.ts; scripts/environment/test_roof_shape.mjs; scripts/environment/test_village_facade_kits.mjs; scripts/environment/test_village_building_overrides.mjs
READ ONLY: existing source/data/assets; outputs/village-fidelity-20261004/references; capture manifest and images.
FORBIDDEN: other edits, commits, subagents, Google imagery, pretending photos prove facades; changing footprint/position/max LiDAR heights; unvalidated fan geometry on concave hipped footprint.
CONTRACT: explicit building overrides win evidence kits, artistic selection, stable hash; every actual renderer parameter connected; use existing batches/materials; one writer.
EXPECTED RESULT: five real bounded visible structure changes, objective tests and diff report. If geometry not safe report BLOCKED rather than false fidelity.
VALIDATION: relevant roof/facade/material/village checks and npm run typecheck; cross-review and actual same cameras after integration by orchestrator.
REPORT: STATUS / FILES / WHAT / VERIFY / RISKS / BLOCKERS.
FALLBACK: OpenCode HTTP 403 country restriction; WorkBuddy callable interface absent. Actual tool used Codex; no free WorkBuddy claim.

Actual renderer formula corrected initial inferred inventory: 708/245 are shed, 649085 already gable but PCA ridge82.4deg disagrees with north-south reference. Use concave footprint clipping for hip override, never unsafe perimeter fan.

Worker stopped after interrupted turn. Source ownership released to root; completion remains subject to fresh independent review and final gates.
