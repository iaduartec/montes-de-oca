# v1-village-audit
STATUS: DELIVERED / REVIEWED
WORKER: Codex / village_audit
MODEL: GPT-6 Luna / gpt-6-luna (spawn override observed)
REPO: /home/kiri_/projects/montes-de-oca-offroad
BASELINE: HEAD 349d984; dirty state preserved in outputs/village-fidelity-20261004/baseline/local-before.patch and status.txt.
OBJECTIVE: READ ONLY; identify 20 OSM buildings and five evidence-supported changes.
OWNED FILES: scripts/environment/audit_village_fidelity.mjs; docs/environment/VILLAGE_FIDELITY_AUDIT.md; outputs/village-fidelity-20261004/inventory/
READ ONLY: AGENTS.md; OBJECTIVE.md; orchestration/MODEL_POOL.md; relevant .agents/skills; existing source/data/assets/scripts.
FORBIDDEN: writes outside ownership; commits; cleanup; subprocess agents; credentials; Google imagery; claiming inferred features as measured.
CONTRACT: preserve OSM footprint, coordinates, datum, LiDAR, gameplay; report observed evidence and limitations.
EXPECTED RESULT: findings with paths and metrics or actual fixed-camera PNGs/JSON.
VALIDATION: relevant existing validators; actual browser for capture task.
REPORT: STATUS / FILES / WHAT / VERIFY / RISKS / BLOCKERS.

2026-10-04 scope update: analyzer now writes deterministic audit tool and report only; root retains evidence ledger and validator. Renderer untouched until baseline capture completes.

Worker stopped after interrupted turn. Source ownership released to root; completion remains subject to fresh independent review and final gates.
