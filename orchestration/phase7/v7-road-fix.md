# V7 rendered road profile fix
STATUS: ACCEPTED_SCOPED — final compressed-edge pavement fix; documented skirt cost, PATH blocker remains
WORKER: Codex / roads_analysis
MODEL: GPT-6 Luna / gpt-6-luna
REPO: /home/kiri_/projects/montes-de-oca-offroad
BASELINE: 349d984 plus preserved dirty changes; see baseline/local-before.patch.
OBJECTIVE: Reproduce and fix generated rendered pavement discontinuities under existing cut/fill caps; preserve OSM, bridges, datum, water/moto.
OWNED FILES: src/road-draping.ts; src/road-profile.ts; scripts/roads/test_road_geometry.mjs; outputs/village-fidelity-20261004/road-fix/
READ ONLY: remaining source, diagnostics, village assets, AGENTS/OBJECTIVE/skills.
FORBIDDEN: other edits, normal-only clamps, arbitrary widening grading caps, commits, subagents, reverting existing changes.
CONTRACT: snapshot owned dirty sources before edits; one writer; compare actual rendered triangles and contacts.
VALIDATION: npm run test:road-surface; comparative diagnostics; orchestrator full gates and independent review afterwards.
EXPECTED RESULT: bounded patch or reproducible blocker, metrics and regression fixture.
REPORT: STATUS / FILES / WHAT / VERIFY / RISKS / BLOCKERS.
FALLBACK: OpenCode read-only connectivity failed provider.auth 403 country restriction. WorkBuddy callable interface absent. Codex authorized analyst reused with explicit ownership; this is not an OpenCode/WorkBuddy execution.

Ownership expanded to src/road-draping.ts after full network regression isolates reconcileJunctions cause on way548355745 (grade5.199, isolated way <1). Snapshot fresh dirty diff before production edit; no overlapping writers. Hold production writes until BEFORE cameras frozen.

Worker stopped after interrupted turn. Source ownership released to root; completion remains subject to fresh independent review and final gates.
