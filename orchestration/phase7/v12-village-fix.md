# V12 village integration corrections
STATUS: ACCEPTED_SCOPED / SOURCE FROZEN — mesh/height gates and built gameplay verified
WORKER: Codex / village_fix
MODEL: GPT-6 Luna / gpt-6-luna
REPO: /home/kiri_/projects/montes-de-oca-offroad
OWNED FILES: src/environment/village.ts; src/environment/village-roof-geometry.ts; src/environment/village-facade-kits.ts; src/environment/village-building-overrides.ts; scripts/environment/test_village_building_overrides.mjs; outputs/village-fidelity-20261004/village-fix/
READ ONLY: all other files.
OBJECTIVE: Preserve actual baseline gable roof peak while rotating ridge; inspect/fix targeted gable containment, hip boundary/wall continuity and compact hips; connect facade kit precedence to runtime without invented evidence.
CONTRACT: snapshot before correction; preserve OSM/LiDAR/datum/base and fallback behaviour; one writer; root evidence/package files untouched.
VALIDATION: meaningful rendered geometry fixtures, no tautological height assertion, focused types/village gates; independent source/AFTER review afterwards.
FORBIDDEN: subagents; commits; source writes before reviewer first-pass finish; Google imagery; invented facade facts; broad redesign.
REPORT: STATUS / FILES / WHAT / VERIFY / RISKS / BLOCKERS.

DELIVERY: clipped gables, roof-boundary wall joins, preserved ridge maximum, compact hips, typed runtime facade kit sources. `npm run test:village-fidelity` and typecheck passed. Root removed remaining tautological helper assertion; rendered-buffer area/peak/join tests retained.

FOLLOW-UP: same worker assigned read-only built-runtime mission/motorcycle/water checks; ownership only outputs/village-fidelity-20261004/gameplay/.

GAMEPLAY DELIVERY: built dist mission 28/28, COMPLETED, seven images, zero console errors; road-v3, motorcycle, water gameplay and water contact checks exit 0. Independent source review: review/source-final-review.md; ledger acceptance and fresh comparable captures must be reconciled by root. Source ownership released.
